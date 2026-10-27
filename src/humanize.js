/**
 * 拟人化：把模型的原始输出加工成"像真人发出来的 QQ 消息"，
 * 并算出该等多久再发（打字延迟、分段、偶尔不回、贴表情）。
 */
import { clamp, logNormalJitter, pick, randFloat } from './util.js';

const NARRATION_WORDS = /(停顿|叹气|沉默|顿了顿|轻声|语气|想了想|笑了笑|挠头|摊手|无奈地|认真地|小声)/;

const AI_TICS = [
  [/作为(一个)?\s*(AI|人工智能|语言模型|智能助手|助手|智能体|机器人)[，,。:：]?\s*/gi, ''],
  [/(根据|基于)我(的)?(知识库|训练数据|了解)[，,。:：]?\s*/g, ''],
  [/希望(这些|这)(对|能帮)(你|您)?[^。！？\n]*[。！？]?/g, ''],
  [/(总之|总的来说|总而言之|综上)[，,：:]?\s*/g, ''],
  [/需要(注意|提醒)(的)?(是|一点)[，,：:]?\s*/g, ''],
  [/(以下|下面)(是|为)[^：:\n]{0,12}[：:]\s*/g, ''],
  [/(首先|其次|再次|最后|另外|此外|同时)[，,：:]\s*/g, ''],
  [/我(很)?理解(你|您)的(感受|心情|处境)[，,。]?\s*/g, ''],
  [/如果有(其他|任何)(问题|需要)[^。！？\n]*[。！？]?/g, ''],
  [/(作为|身为)(一个)?\s*(朋友|人类)[，,]?\s*/g, ''],
];

function stripMarkdown(text) {
  return text
    .replace(/```[a-zA-Z0-9]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)__([^_]+)__(?!\w)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/\[([^\]]+)\]\((?:[^)\s]+)\)/g, '$1')
    .replace(/^\s*[-—_=]{3,}\s*$/gm, '');
}

function stripNarration(text) {
  // 星号旁白：*微笑* / **叹气**
  let out = text.replace(/\*+([^*\n]{1,20})\*+/g, '');
  // 括号旁白：只删掉明显是动作描述的
  out = out.replace(/[（(]([^()（）\n]{1,24})[)）]/g, (match, inner) => (NARRATION_WORDS.test(inner) ? '' : match));
  return out;
}

function stripAiTics(text) {
  let out = text;
  for (const [pattern, replacement] of AI_TICS) out = out.replace(pattern, replacement);
  return out;
}

function compressPunctuation(text) {
  return text
    .replace(/([！!])[！!]+/g, '$1')
    .replace(/([？?])[？?]+/g, '$1')
    .replace(/[。.]{3,}/g, '…')
    .replace(/~{2,}/g, '~')
    .replace(/[ \t]{2,}/g, ' ');
}

function stripEmoji(text) {
  return text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '');
}

/** 整条命中露馅正则时，尽量只删掉出问题的那一句。 */
function dropForbiddenLines(text, patterns) {
  if (!patterns?.length) return text;
  const compiled = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch {
      /* 配置错误在启动校验里已经报过 */
    }
  }
  if (!compiled.length) return text;
  const kept = text
    .split(/(?<=[。！？!?…~\n])/)
    .filter((chunk) => !compiled.some((regex) => regex.test(chunk)));
  return kept.join('');
}

function trimTo(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('…'),
    head.lastIndexOf('\n'),
  );
  return cut > max * 0.5 ? head.slice(0, cut + 1) : `${head}…`;
}

export function sanitize(rawText, config) {
  const options = config.humanize;
  let text = String(rawText ?? '').replace(/\r\n?/g, '\n');

  text = text.replace(/^\s*<skip>\s*$/i, '');
  text = stripMarkdown(text);
  text = stripNarration(text);
  text = stripAiTics(text);
  text = dropForbiddenLines(text, config.persona.forbiddenPatterns);
  if (options.compressRepeatedPunctuation) text = compressPunctuation(text);
  if (!options.allowEmoji) text = stripEmoji(text);
  text = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();

  if (!text) return '';

  if (Math.random() < options.dropTrailingPeriod) {
    text = text.replace(/([^。！？!?…~\s])。(\s*)$/, '$1$2');
  }

  return text;
}

/** 按语义断点把一条长回复拆成"人连着打的几条消息"。 */
export function splitIntoMessages(text, config) {
  const options = config.humanize.split;
  if (!options.enabled) return [text];

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  // 模型自己换行，就是在表示"这几条分开发"
  if (lines.length > 1) {
    if (lines.length <= options.maxParts) return lines;
    const head = lines.slice(0, options.maxParts - 1);
    head.push(lines.slice(options.maxParts - 1).join(''));
    return head;
  }

  const single = lines[0] ?? text;
  if (single.length <= options.minLength) return [single];

  const segments = [];
  const sentences = single.split(/(?<=[。！？!?…~])/).filter((s) => s.trim());
  let buffer = '';
  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length > 42) {
      segments.push(buffer);
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  if (buffer) segments.push(buffer);

  if (segments.length <= options.maxParts) return segments;

  // 段数太多：把后面的合并进最后一段，保证最多 maxParts 条
  const head = segments.slice(0, options.maxParts - 1);
  head.push(segments.slice(options.maxParts - 1).join(''));
  return head;
}

function typingMs(text, config) {
  const [minCpm, maxCpm] = config.humanize.charsPerMinute;
  const cpm = randFloat(Math.min(minCpm, maxCpm), Math.max(minCpm, maxCpm));
  const perChar = 60000 / cpm;
  const jitter = logNormalJitter(config.humanize.jitter);
  return text.length * perChar * jitter;
}

function reactionMs(config) {
  const [min, max] = config.humanize.reactionMs;
  return randFloat(min, max) * logNormalJitter(config.humanize.jitter * 0.6);
}

/**
 * 生成发送计划。
 * elapsedMs 是 reasonix 思考已经花掉的时间——它本来就构成"对方在打字"的时间，
 * 所以只用补差额；完全没有差额时也要留一点停顿，避免真正的"秒回"。
 */
/** 把 [表情:笑] / 【表情：笑】 这类标记从文本里抽出来，返回干净文本 + 表情名字列表。 */
export function extractStickerTokens(text, config) {
  const tokenName = config?.stickers?.tokenName ?? '表情';
  const escaped = String(tokenName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`[\\[【]\\s*${escaped}\\s*[:：]\\s*([^\\]】\\n]{1,24})\\s*[\\]】]`, 'g');
  const names = [];
  const cleaned = String(text ?? '').replace(regex, (match, name) => {
    const value = String(name).trim();
    if (value) names.push(value);
    return '';
  });
  return { text: cleaned, names };
}

/** 把选中的表情包变成发送计划里的一项（发图不用"打字时间"，只需要一点停顿）。 */
function stickerParts(items, config, firstDelayMs = 0) {
  const [minPause, maxPause] = config.humanize.stickerPauseMs ?? [400, 1400];
  const maxDelay = config.humanize.maxDelayMs;
  return items.map((item, index) => ({
    kind: 'sticker',
    name: item.name,
    file: item.file,
    delayMs: Math.round(index === 0 ? clamp(firstDelayMs, 0, maxDelay) : randFloat(minPause, maxPause)),
  }));
}

/**
 * 生成发送计划。
 * elapsedMs 是 reasonix 思考已经花掉的时间——它本来就构成"对方在打字"的时间，
 * 所以只用补差额；完全没有差额时也要留一点停顿，避免真正的"秒回"。
 * resolveSticker(name) 用来确认表情包是否真的存在，返回 null 就当模型写错了、忽略掉。
 */
export function buildSendPlan({ rawText, config, elapsedMs = 0, resolveSticker = null }) {
  const options = config.humanize;
  const raw = String(rawText ?? '');
  if (/^\s*<skip>\s*$/i.test(raw.trim())) return { skip: true, reason: 'model-skip', parts: [] };

  const extracted = extractStickerTokens(raw, config);
  const maxStickers = Math.max(1, Number(config.stickers?.maxPerReply ?? 1));
  const chosen = [];
  const unknownStickers = [];
  for (const name of extracted.names) {
    if (chosen.length >= maxStickers) break;
    const item = resolveSticker ? resolveSticker(name) : null;
    if (item) chosen.push(item);
    else unknownStickers.push(name);
  }

  const text = sanitize(extracted.text, config);
  if (!text && !chosen.length) return { skip: true, reason: 'empty', parts: [], unknownStickers };

  // 只想发个表情、不说话
  if (!text && chosen.length) {
    return { skip: false, reason: 'sticker-only', parts: stickerParts(chosen, config, reactionMs(config)), unknownStickers };
  }

  const parts = splitIntoMessages(trimTo(text, options.maxLength), config).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) {
    if (!chosen.length) return { skip: true, reason: 'empty', parts: [], unknownStickers };
    return { skip: false, reason: 'sticker-only', parts: stickerParts(chosen, config, reactionMs(config)), unknownStickers };
  }

  if (!options.enabled) {
    return {
      skip: false,
      reason: null,
      unknownStickers,
      parts: [
        ...parts.map((part) => ({ kind: 'text', text: part, delayMs: 0 })),
        ...stickerParts(chosen, config, 0),
      ],
    };
  }

  const planned = [];
  let remaining = elapsedMs;

  parts.forEach((part, index) => {
    const needed = (index === 0 ? reactionMs(config) : 0) + typingMs(part, config);
    let delay;
    if (remaining > needed) {
      remaining -= needed;
      delay = 0;
    } else {
      delay = needed - remaining;
      remaining = 0;
    }
    planned.push({ kind: 'text', text: part, delayMs: Math.round(clamp(delay, 0, options.maxDelayMs)) });
  });

  // 思考太久导致完全没等待：补一个短停顿，别像机器人一样瞬间回
  if (planned.every((part) => part.delayMs < 120)) {
    const [minGap, maxGap] = options.minThinkGapMs;
    planned[0].delayMs += Math.round(randFloat(minGap, maxGap));
    planned[0].delayMs = Math.round(clamp(planned[0].delayMs, 0, options.maxDelayMs));
  }

  // 多条之间的间隔
  if (planned.length > 1) {
    const [minPause, maxPause] = options.split.pauseMs;
    for (let i = 1; i < planned.length; i += 1) {
      planned[i].delayMs += Math.round(randFloat(minPause, maxPause));
    }
  }

  // 表情包跟在文字后面，隔一小会儿再发（像真人说完话补个图）
  if (chosen.length) {
    const [minPause, maxPause] = options.stickerPauseMs ?? [400, 1400];
    planned.push(...stickerParts(chosen, config, randFloat(minPause, maxPause)));
  }

  return { skip: false, reason: null, parts: planned, unknownStickers };
}

/** 被叫到了也有小概率懒得回（配置默认 0，开了更像真人但偶尔会让人以为坏了）。 */
export function shouldIgnore(config, { atSelf = false } = {}) {
  const probability = Number(config.humanize.ignoreProbability) || 0;
  if (probability <= 0) return false;
  if (atSelf) return false; // 点名了还是回
  return Math.random() < probability;
}

export function shouldLikeInstead(config) {
  const options = config.humanize.emojiLike;
  if (!options?.enabled) return false;
  return Math.random() < Number(options.probability || 0);
}

export function pickEmojiId(config) {
  const list = config.humanize.emojiLike?.ids;
  if (Array.isArray(list) && list.length) return String(pick(list));
  return String(config.humanize.emojiLike?.maxId ?? '424');
}
