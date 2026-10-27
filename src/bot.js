/**
 * 机器人主流程：
 *   NapCat 事件 → 过滤/记忆 → 触发判定 → 合并连发消息 → 交给 reasonix 思考
 *   → 拟人化加工（分段/延迟/净化）→ 发回 QQ
 */
import { MemoryStore } from './memory.js';
import { OneBotClient } from './onebot.js';
import { buildTaskPrompt, preparePersona } from './persona.js';
import { ReasonixRunner } from './reasonix.js';
import { TriggerPolicy } from './trigger.js';
import { buildSendPlan, pickEmojiId, shouldIgnore, shouldLikeInstead } from './humanize.js';
import { analyzeHabits } from './habits.js';
import { SelfEvolver } from './evolve.js';
import { StickerStore } from './stickers.js';
import { ImageDescriber } from './vision.js';
import { sleep } from './util.js';

const ERROR_FALLBACKS = ['刚手机卡了下，你再说一次', '啊 刚才消息没刷出来 再说下'];

export class QQBot {
  constructor({ config, logger, dataDir }) {
    this.config = config;
    this.logger = logger;
    this.dataDir = dataDir;
    this.personaDir = preparePersona({ config, dataDir, logger });
    this.memory = new MemoryStore({ config, dataDir, logger });
    this.onebot = new OneBotClient({ config, logger });
    this.runner = new ReasonixRunner({ config, logger, personaDir: this.personaDir });
    this.trigger = new TriggerPolicy({ config, logger });
    this.stickers = new StickerStore({ config, logger });
    this.vision = new ImageDescriber({ config, logger, dataDir });

    // 自我认知进化用独立的 runner（并发 1），不和聊天抢资源
    const evolveRunnerConfig = {
      ...config,
      reasonix: {
        ...config.reasonix,
        concurrency: 1,
        model: config.persona?.evolve?.model || config.reasonix.model,
        minIntervalMs: 0,
      },
    };
    this.evolveRunner = new ReasonixRunner({
      config: evolveRunnerConfig,
      logger,
      personaDir: this.personaDir,
      label: '自我认知',
    });
    this.evolver = new SelfEvolver({
      config,
      logger,
      dataDir,
      runPrompt: async (prompt) => {
        const result = await this.evolveRunner.run({ chatKey: 'evolve', prompt, timeoutMs: 120000 });
        return result.text;
      },
    });

    this.pendingBatches = new Map(); // chatKey -> { items, timer }
    this.chains = new Map(); // chatKey -> Promise（保证同一会话串行）
    this.groupNames = new Map();
    this.stopped = false;
  }

  async start() {
    this.onebot.on('message', (message) => this.handleMessage(message));
    this.onebot.on('request', (event) => {
      this.logger.info(`收到好友/加群请求：${event.request_type ?? ''} ${event.comment ?? ''}`);
    });

    await this.onebot.start();

    this.stickers.ensureDirs();
    this.stickers.refresh();
    if (this.stickers.enabled) {
      this.logger.info(
        this.stickers.items.size
          ? `可用表情包 ${this.stickers.items.size} 张：${this.stickers.describe()}`
          : `还没有可用的表情包；把图放进 ${this.stickers.root}（文件名就是含义，比如 笑.gif）`,
      );
    }

    this.logger.info(`机器人「${this.config.persona.name}」已启动，正在等待 QQ 连接…`);

    const connected = await this.onebot.waitForConnection(15000);
    if (connected) {
      try {
        const info = await this.onebot.getLoginInfo();
        this.onebot.selfId = String(info?.user_id ?? this.onebot.selfId);
        this.logger.info(`已登录账号：${info?.nickname ?? '未知'}（${this.onebot.selfId}）`);
        // 顺手把 QQ 收藏表情同步下来（NapCat 不支持就算了，不影响主流程）
        this.stickers.syncFavorites(this.onebot).catch(() => {});
      } catch (error) {
        this.logger.warn(`获取登录信息失败：${error.message}`);
      }
      if (!this.onebot.selfId) {
        this.logger.warn('拿不到机器人的 QQ 号，可在 config.json 的 onebot.selfId 里手动填写');
      }
    } else if (this.config.onebot.mode === 'reverse-ws') {
      this.logger.warn(
        `还没有收到 NapCat 的连接。请检查 NapCat 的网络配置：反向 WebSocket 地址指向 ws://${this.config.onebot.host}:${this.config.onebot.port}${this.config.onebot.path}`,
      );
    }
  }

  /** message: OneBotClient 规范化后的事件 */
  handleMessage(message) {
    if (this.stopped) return;

    if (message.kind === 'group' && message.groupId && !this.groupNames.has(message.groupId)) {
      this.resolveGroupName(message.groupId);
    }

    this.memory.append(message.chatKey, {
      speaker: message.nickname,
      userId: message.userId,
      isSelf: message.isSelf,
      text: message.text || '[图片]',
      atSelf: message.atSelf,
      messageId: message.messageId,
      time: message.time,
    });

    // 顺手把别人发的表情包收进 inbox（不阻塞主流程）
    if (!message.isSelf) {
      this.stickers.collectFromMessage(message, this.onebot).catch(() => {});
    }

    if (message.isSelf) return;

    const decision = this.trigger.evaluate(message);
    this.logger.debug(
      `[${message.chatKey}] ${message.nickname}: ${message.text || '(空)'} → ${decision.reply ? '回复' : '忽略'}(${decision.reason})`,
    );
    if (!decision.reply) return;

    if (shouldIgnore(this.config, { atSelf: message.atSelf })) {
      this.logger.info(`[${message.chatKey}] 决定这次看到但不回（拟人化的"懒得理"）`);
      return;
    }

    // 群里被叫到时小概率只贴个表情，代表"看到了"
    if (message.kind === 'group' && message.messageId && shouldLikeInstead(this.config)) {
      this.onebot
        .likeMessage(message.messageId, pickEmojiId(this.config))
        .then((ok) => {
          if (ok) this.logger.info(`[${message.chatKey}] 只贴了个表情回应 ${message.nickname}`);
        })
        .catch(() => {});
      return;
    }

    this.enqueue(message);
  }

  async resolveGroupName(groupId) {
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) this.groupNames.set(groupId, String(info.group_name));
    } catch {
      this.groupNames.set(groupId, null);
    }
  }

  /** 同一个人连发几条时，等一小会儿一起思考，避免逐条回。 */
  enqueue(message) {
    const chatKey = message.chatKey;
    let batch = this.pendingBatches.get(chatKey);
    if (!batch) {
      batch = { items: [], timer: null, lastMessage: message };
      this.pendingBatches.set(chatKey, batch);
    }
    batch.items.push(message);
    batch.lastMessage = message;

    const max = this.config.trigger.queueMax;
    if (batch.items.length > max) batch.items.splice(0, batch.items.length - max);

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      this.pendingBatches.delete(chatKey);
      this.submit(chatKey, batch.items);
    }, this.config.trigger.debounceMs);
    batch.timer.unref?.();
  }

  submit(chatKey, items) {
    const previous = this.chains.get(chatKey) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => this.processBatch(chatKey, items))
      .catch((error) => this.logger.error(`处理 ${chatKey} 的消息失败：`, error));
    const wrapped = task.finally(() => {
      if (this.chains.get(chatKey) === wrapped) this.chains.delete(chatKey);
    });
    this.chains.set(chatKey, wrapped);
  }

  /**
   * 把批次里含图片/表情包的消息，先用视觉模型变成一句文字描述。
   * 描述会写回内存历史，所以后面几轮她也"记得"那张图是什么。
   */
  async enrichImages(chatKey, items) {
    if (!this.vision.enabled) return 0;

    let described = 0;
    for (const item of items) {
      if (!Array.isArray(item.segments)) continue;
      const segment = item.segments.find(
        (candidate) =>
          candidate?.type === 'image' || candidate?.type === 'mface' || candidate?.type === 'marketface',
      );
      if (!segment) continue;
      if (!/\[图片\]|\[表情包\]/.test(item.text ?? '')) continue;

      try {
        const picked = await this.stickers.readImageBytes(segment.data ?? {}, this.onebot);
        if (!picked?.buffer?.length) continue;

        const description = await this.vision.describe({
          buffer: picked.buffer,
          mimeType: this.guessMime(picked.ext),
        });
        if (!description) continue;

        const replaced = String(item.text).replace(/\[图片\]|\[表情包\]/, `[图：${description}]`);
        item.text = replaced;
        this.memory.updateText(chatKey, item.messageId, replaced);
        described += 1;
      } catch (error) {
        this.logger.debug(`识别图片消息失败：${error.message}`);
      }
    }
    return described;
  }

  guessMime(ext = '') {
    const value = String(ext).toLowerCase();
    if (value === '.png') return 'image/png';
    if (value === '.webp') return 'image/webp';
    if (value === '.gif') return 'image/gif';
    if (value === '.bmp') return 'image/bmp';
    return 'image/jpeg';
  }

  buildContext(chatKey, items) {
    const message = items[items.length - 1];
    const batchSize = items.length;
    let history = this.memory.historyBefore(chatKey, batchSize, this.config.memory.injectMessages);

    const make = () => ({
      kind: message.kind,
      groupId: message.groupId,
      groupName: message.groupId ? this.groupNames.get(message.groupId) : null,
      history,
      batch: items.map((item) => ({
        speaker: item.nickname,
        isSelf: item.isSelf,
        text: item.text || '[图片]',
        atSelf: item.atSelf,
        time: item.time,
      })),
    });

    // 每次思考前刷新一次，这样你新丢进表情包文件夹的图不用重启就能用
    this.stickers.refresh();
    const stickerHint = this.stickers.enabled ? this.stickers.describe() : '';
    // 她自己的笔记（会随聊天慢慢长），放在提示词里而不是 system prompt 里，
    // 这样 system prompt 保持稳定，能命中 prompt 缓存
    const selfNote = this.evolver.enabled ? this.evolver.read() : '';

    // 自查：她是不是又在反复用同一个结尾/口头禅
    const habit =
      this.config.humanize?.selfCheck === false ? null : analyzeHabits(this.memory.recent(chatKey, 30));
    const habitNote = habit?.summary ?? '';

    // 让她看见自己最近说过什么（跨会话）。模型自己记不住，只能把原文摆给它看
    const echoLimit = Number(this.config.memory?.selfEcho?.limit ?? 12);
    const selfEcho =
      this.config.memory?.selfEcho?.enabled === false
        ? []
        : this.memory.recentSelfMessages(echoLimit, { excludeChat: chatKey }).map((item) => ({
            text: item.text,
            label: item.chatKey.startsWith('group:') ? `群 ${item.chatKey.slice(6)}` : '私聊',
          }));

    const build = () =>
      buildTaskPrompt({
        config: this.config,
        context: make(),
        stickers: stickerHint,
        selfNote,
        habitNote,
        selfEcho,
      });
    let prompt = build();
    // 超长就从最旧的历史开始丢
    while (prompt.length > this.config.reasonix.maxPromptChars && history.length > 0) {
      history = history.slice(Math.ceil(history.length / 4) || 1);
      prompt = build();
    }

    return { prompt, message, context: make(), habitNote };
  }

  async processBatch(chatKey, items) {
    // 这批消息里有图片的话，先让视觉模型看一遍（reasonix 自己读不了二进制图片）
    await this.enrichImages(chatKey, items);

    const { prompt, message, habitNote } = this.buildContext(chatKey, items);
    const preview = items.map((item) => item.text || '[图片]').join(' / ');
    this.logger.info(`[${chatKey}] 思考中…（${items.length} 条：${preview.slice(0, 80)}）`);

    const startedAt = Date.now();
    let result;
    try {
      result = await this.runner.run({ chatKey, prompt });
    } catch (error) {
      this.logger.error(`[${chatKey}] reasonix 思考失败：${error.message}`);
      if (this.config.behavior?.replyOnError) {
        await this.sendText(message, ERROR_FALLBACKS[Math.floor(Math.random() * ERROR_FALLBACKS.length)]).catch(() => {});
      }
      return;
    }

    const elapsed = Date.now() - startedAt;
    const plan = buildSendPlan({
      rawText: result.text,
      config: this.config,
      elapsedMs: elapsed,
      resolveSticker: (name) => this.stickers.resolve(name),
    });
    if (plan.unknownStickers?.length) {
      this.logger.warn(`[${chatKey}] 模型想发不存在的表情包：${plan.unknownStickers.join('、')}（已忽略）`);
    }

    // 表情包频率控制：发得太勤就不发了，真人不会每条消息都甩表情
    if (plan.parts.some((part) => part.kind === 'sticker') && !this.stickers.canSend(message.chatKey)) {
      plan.parts = plan.parts.filter((part) => part.kind !== 'sticker');
      if (!plan.parts.length) {
        this.logger.info(`[${chatKey}] 只想发表情包但被频率限制拦下，这次不回`);
        return;
      }
      this.logger.debug(`[${chatKey}] 表情包发得太勤，这次只发文字`);
    }

    if (plan.skip) {
      this.logger.info(`[${chatKey}] 这次不回复（${plan.reason}），思考用了 ${elapsed}ms`);
      return;
    }

    if (this.config.humanize.typingStatus && plan.parts[0].delayMs > 1200) {
      await this.onebot
        .setInputStatus({ userId: message.kind === 'private' ? message.userId : null, groupId: message.groupId })
        .catch(() => {});
    }

    await this.sendPlan(message, plan);
    this.trigger.noteReply(chatKey);
    this.logger.info(
      `[${chatKey}] 已回复（思考 ${elapsed}ms，共 ${Date.now() - startedAt}ms）：${plan.parts
        .map((part) => (part.kind === 'sticker' ? `[表情:${part.name}]` : part.text))
        .join(' ⏎ ')}`,
    );

    // 聊完这一轮，让她在后台把这次学到的东西写进自己的笔记（不阻塞回复）
    this.evolver.schedule([
      ...items.map((item) => `${item.nickname}: ${item.text || '[图片]'}`),
      ...plan.parts
        .filter((part) => part.kind === 'text')
        .map((part) => `${this.config.persona.name}: ${part.text}`),
      // 把"她又犯了什么毛病"也告诉她，让她改进说话方式，而不只是记事情
      ...(habitNote ? [`（她自己察觉到的毛病：${habitNote}）`] : []),
    ]);
  }

  async sendPlan(message, plan) {
    for (const [index, part] of plan.parts.entries()) {
      if (part.delayMs > 0) await sleep(part.delayMs);
      const isSticker = part.kind === 'sticker';
      const quote = this.config.trigger.replyQuote && index === 0 ? message.messageId : null;
      try {
        if (isSticker) await this.sendSticker(message, part);
        else await this.sendText(message, part.text, { quote });
      } catch (error) {
        this.logger.error(`${isSticker ? '发送表情包' : '发送消息'}失败：${error.message}`);
        if (!isSticker) return;
        continue;
      }
      this.memory.append(message.chatKey, {
        speaker: this.config.persona.name,
        isSelf: true,
        text: isSticker ? `[表情包:${part.name}]` : part.text,
        messageId: null,
        time: Date.now(),
      });
    }
    if (this.config.memory.persist) this.memory.flush();
  }

  sendText(message, text, { quote = null } = {}) {
    const payload = quote
      ? [
          { type: 'reply', data: { id: String(quote) } },
          { type: 'text', data: { text } },
        ]
      : text;
    if (message.kind === 'group') return this.onebot.sendGroupMsg(message.groupId, payload);
    return this.onebot.sendPrivateMsg(message.userId, payload);
  }

  /**
   * 发表情包。先试 base64（OneBot 11 标准格式，最兼容），
   * 万一 NapCat 不认，自动退回本地绝对路径再试一次。
   */
  async sendSticker(message, part) {
    const candidates = this.stickers.sendCandidates(part);
    if (!candidates.length) {
      this.logger.warn(`表情包不可用，跳过：${part?.name ?? '(未知)'}`);
      return;
    }

    let lastError = null;
    for (const file of candidates) {
      const payload = [{ type: 'image', data: { file } }];
      try {
        if (message.kind === 'group') await this.onebot.sendGroupMsg(message.groupId, payload);
        else await this.onebot.sendPrivateMsg(message.userId, payload);
        this.stickers.noteSent(message.chatKey);
        return;
      } catch (error) {
        lastError = error;
        const how = String(file).startsWith('base64://') ? 'base64' : '本地路径';
        this.logger.debug(`用 ${how} 发表情包失败，换另一种方式再试：${error.message}`);
      }
    }
    throw lastError ?? new Error('表情包发送失败');
  }

  async stop() {
    this.stopped = true;
    for (const batch of this.pendingBatches.values()) {
      if (batch.timer) clearTimeout(batch.timer);
    }
    this.pendingBatches.clear();
    this.evolver.close();
    await this.runner.stop();
    await this.evolveRunner.stop();
    await this.onebot.stop();
    this.memory.close();
    this.logger.info(this.runner.summary());
    this.logger.info(this.evolver.summary());
    this.logger.info(this.vision.summary());
  }
}
