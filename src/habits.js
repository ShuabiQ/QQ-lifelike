/**
 * 说话习惯自查。
 *
 * 为什么需要它：模型看不到自己刚才说了什么，所以一旦人设里写了「带波浪号」，
 * 它就会条条都带——越聊越腻。这里由程序统计她最近的回复，把"你最近老用一个调子"
 * 这件事算出来告诉她，她当次就能换说法，进化时也会记进笔记。
 */

const DEFAULT_SAMPLE = 12;
const MIN_SAMPLE = 5;
const ENDING_RATIO = 0.6; // 同一个结尾字符占到 60% 就算"一个调子"
const WORD_RATIO = 0.8; // 某个口头禅出现在 80% 的句子里才算

const WATCH_WORDS = ['hhh', 'qwq', '捏', '啦', '呀', '～', '~', '…'];

/**
 * @param messages 会话记录（含对方的，内部只挑 isSelf 的）
 * @returns {null | { sample: number, notes: string[], summary: string }}
 */
export function analyzeHabits(messages, { sample = DEFAULT_SAMPLE, ratio = ENDING_RATIO, minSample = MIN_SAMPLE } = {}) {
  const own = (messages ?? []).filter((message) => message?.isSelf).slice(-sample);
  if (own.length < minSample) return null; // 样本太少，不下结论

  const notes = [];

  // 1) 是不是老用同一个结尾（~ / ～ / … / 哈 之类）
  const endings = new Map();
  for (const message of own) {
    const text = String(message.text ?? '').trim();
    if (!text) continue;
    const chars = [...text];
    const last = chars[chars.length - 1] ?? '';
    if (!last || /\s/.test(last)) continue;
    endings.set(last, (endings.get(last) ?? 0) + 1);
  }

  const sorted = [...endings.entries()].sort((a, b) => b[1] - a[1]);
  const [topChar, topCount] = sorted[0] ?? [];
  if (topChar && topCount / own.length >= ratio) {
    notes.push(`最近 ${own.length} 条回复里有 ${topCount} 条是以「${topChar}」结尾的`);
  }

  // 2) 某个口头禅是不是快成固定模板了
  for (const word of WATCH_WORDS) {
    const hits = own.filter((message) => String(message.text ?? '').toLowerCase().includes(word)).length;
    if (hits / own.length >= WORD_RATIO) notes.push(`${own.length} 条里有 ${hits} 条带「${word}」`);
  }

  if (!notes.length) return null;
  return { notes, sample: own.length, summary: notes.join('；') };
}
