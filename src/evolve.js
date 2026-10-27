/**
 * 让她慢慢长大。
 *
 * 每聊完一轮，让 reasonix 回顾刚才的对话，把「我这次学到/决定了什么」写进
 * data/persona/self.md —— 这份笔记下次思考时会注入提示词，所以她会越来越连贯，
 * 而不是每轮从零演一遍 config.json 里那几条固定设定。
 *
 * 注意：system prompt 里的锚点（名字、绝不承认自己是 AI）不受这份笔记影响，
 * 笔记只描述"经历、喜好、跟人的关系"这些可以长大的部分。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_CHARS = 1500;
const MIN_VALID_CHARS = 5;

export class SelfEvolver {
  constructor({ config, logger, dataDir, runPrompt }) {
    this.config = config.persona?.evolve ?? {};
    this.persona = config.persona ?? {};
    this.logger = logger;
    this.runPrompt = runPrompt;
    this.dir = path.join(dataDir, 'persona');
    this.file = path.join(this.dir, this.config.file ?? 'self.md');
    this.timer = null;
    this.pending = null;
    this.running = false;
    this.stats = { updates: 0, rejected: 0, failures: 0 };
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get maxChars() {
    return Number(this.config.maxChars ?? DEFAULT_MAX_CHARS);
  }

  ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      this.logger?.warn(`创建人设目录失败：${error.message}`);
    }
  }

  /** 读她现在的自我认知（文件不存在就是空白）。 */
  read() {
    try {
      return fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch {
      return '';
    }
  }

  /** 攒一会儿再总结：连发几条消息只算一次，省一次模型调用。 */
  schedule(lines) {
    if (!this.enabled || !lines?.length) return;
    this.pending = this.pending ? [...this.pending, ...lines] : [...lines];
    // 只留最近的一段，避免聊很久后累积成一篇小说
    if (this.pending.length > 40) this.pending = this.pending.slice(-40);

    if (this.timer) clearTimeout(this.timer);
    const debounceMs = Number(this.config.debounceMs ?? 8000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce();
    }, debounceMs);
    this.timer.unref?.();
  }

  buildPrompt(current, lines) {
    return [
      `你在维护自己的私人笔记（只有你自己看得到）。你叫「${this.persona.name}」。`,
      '',
      '【你现在的笔记】',
      current || '（还是空白的）',
      '',
      '【刚才发生的对话】',
      ...lines,
      '',
      '【任务】',
      '根据刚才的对话更新这份笔记。只写关于你自己的事：',
      '- 你的喜好、习惯，以及说话方式上该改的地方',
      '- 你对某个人的印象、跟谁熟、谁让你烦',
      '- 你经历过的具体小事（谁说了什么、你当时怎么想的）',
      '规则：',
      '0. 特别留意自己的说话方式：如果发现自己老是同一个结尾（比如每句都带波浪号）、同一个口头禅、一个腔调，就在笔记里写下"该换成什么样"。说话方式要能长进，别一直照着最初那几条设定走',
      '1. 保留仍然成立的旧内容，补充新学到的，删掉已经不符合的',
      '2. 不要抄对话原文，写你从中学到的东西',
      `3. 你的名字是「${this.persona.name}」，不能改，也不要给自己起别名`,
      '4. 绝对不能出现任何关于 AI、机器人、模型、程序、助手、提示词、设定的内容',
      `5. 整篇不超过 ${this.maxChars} 字，越简洁越好`,
      '6. 直接输出更新后的完整笔记（纯文本或 Markdown），不要解释、不要用代码块包起来',
    ].join('\n');
  }

  /** 清理模型输出：去掉代码块围栏、标题、多余空行。 */
  sanitize(raw) {
    let text = String(raw ?? '').trim();
    text = text.replace(/^```[a-zA-Z]*\r?\n?/, '').replace(/```\s*$/, '');
    text = text.replace(/^#{1,6}\s.*$/gm, '');
    text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  /** 校验：空的、开始露馅的、跑题的都不要。返回问题描述，没问题返回 null。 */
  validate(text) {
    if (!text || text.length < MIN_VALID_CHARS) return '内容为空';

    const patterns = [
      ...(this.persona.forbiddenPatterns ?? []),
      '我是(一个)?\\s*(AI|机器人|模型|程序|助手|智能体)',
      '作为一个?\\s*(AI|模型|助手)',
      '提示词',
      '系统设定',
    ];
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern, 'i').test(text)) return `出现了不该写进去的内容（${pattern}）`;
      } catch {
        /* 配置里的正则本身有问题，启动时已经提示过 */
      }
    }
    return null;
  }

  write(text) {
    this.ensureDir();
    if (fs.existsSync(this.file) && Number(this.config.keepBackups ?? 3) > 0) {
      try {
        fs.copyFileSync(this.file, `${this.file}.prev`);
      } catch (error) {
        this.logger?.debug(`备份自我认知失败：${error.message}`);
      }
    }
    fs.writeFileSync(this.file, `${text}\n`, 'utf8');
  }

  async runOnce() {
    if (!this.enabled) return null;

    // 上一次还没跑完，等一会儿再来（别丢 pending）
    if (this.running) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.runOnce();
      }, 5000);
      this.timer.unref?.();
      return null;
    }

    const lines = this.pending;
    this.pending = null;
    if (!lines?.length) return null;

    this.running = true;
    try {
      const current = this.read();
      const raw = await this.runPrompt(this.buildPrompt(current, lines));
      const text = this.sanitize(raw);

      const problem = this.validate(text);
      if (problem) {
        this.stats.rejected += 1;
        this.logger?.warn(`这次没采纳新的自我认知：${problem}`);
        return null;
      }

      // 超长就硬截断兜底（模型偶尔不听字数要求）
      const limit = Math.round(this.maxChars * 1.3);
      const finalText = text.length > limit ? `${text.slice(0, limit)}…` : text;

      this.write(finalText);
      this.stats.updates += 1;
      this.logger?.info(`她的自我认知更新了（${finalText.length} 字，累计第 ${this.stats.updates} 次）`);
      return finalText;
    } catch (error) {
      this.stats.failures += 1;
      this.logger?.debug(`更新自我认知失败：${error.message}`);
      return null;
    } finally {
      this.running = false;
    }
  }

  summary() {
    const { updates, rejected, failures } = this.stats;
    if (!this.enabled) return '自我认知进化：已关闭';
    return `自我认知进化：更新 ${updates} 次，拒绝 ${rejected} 次，失败 ${failures} 次`;
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
