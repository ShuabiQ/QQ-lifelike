import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './jsonc.js';
import { mergeDefaults } from './util.js';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'config.example.jsonc');

let cachedDefaults = null;

/** 默认值来自 config.example.jsonc —— 注释和默认值只有这一份来源，不会漂移。 */
export function defaultConfig() {
  if (!cachedDefaults) {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(`缺少默认配置模板 ${TEMPLATE_PATH}，无法确定默认值`);
    }
    cachedDefaults = parseJsonc(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  }
  // 返回副本：否则调用方改了返回值，会把缓存里的默认值一起改掉，
  // 后面的调用者（其它会话、测试）就会莫名继承上一次的修改。
  return structuredClone(cachedDefaults);
}

function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.QQBOT_CONFIG) return path.resolve(process.env.QQBOT_CONFIG);
  return path.join(PROJECT_ROOT, 'config.json');
}

function validate(config) {
  const problems = [];
  const modes = ['reverse-ws', 'forward-ws', 'http'];
  if (!modes.includes(config.onebot.mode)) {
    problems.push(`onebot.mode 必须是 ${modes.join(' / ')} 之一，当前是 ${config.onebot.mode}`);
  }
  const port = config.onebot.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    problems.push(`onebot.port 不合法：${port}`);
  }
  if (!['ws', 'http'].includes(config.onebot.apiChannel)) {
    problems.push(`onebot.apiChannel 必须是 ws / http，当前是 ${config.onebot.apiChannel}`);
  }
  if (config.reasonix.concurrency < 1) problems.push('reasonix.concurrency 至少为 1');
  for (const pattern of config.persona.forbiddenPatterns ?? []) {
    try {
      new RegExp(pattern);
    } catch (error) {
      problems.push(`persona.forbiddenPatterns 里有非法正则 ${JSON.stringify(pattern)}：${error.message}`);
    }
  }
  const ranges = [
    ['humanize.reactionMs', config.humanize.reactionMs],
    ['humanize.charsPerMinute', config.humanize.charsPerMinute],
    ['humanize.minThinkGapMs', config.humanize.minThinkGapMs],
    ['humanize.split.pauseMs', config.humanize.split.pauseMs],
  ];
  for (const [name, value] of ranges) {
    if (!Array.isArray(value) || value.length !== 2 || value.some((n) => typeof n !== 'number')) {
      problems.push(`${name} 需要写成 [最小值, 最大值] 两个数字`);
    }
  }
  return problems;
}

export function loadConfig({ configPath, logger } = {}) {
  const file = resolveConfigPath(configPath);
  let userConfig = {};
  let generated = false;

  if (fs.existsSync(file)) {
    userConfig = parseJsonc(fs.readFileSync(file, 'utf8'));
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(TEMPLATE_PATH, file);
    generated = true;
    logger?.warn(`没有找到配置文件，已生成 ${file}（内容就是带注释的默认配置，请先检查 persona 段）`);
  }

  const config = mergeDefaults(defaultConfig(), userConfig);
  const problems = validate(config);
  if (problems.length) {
    const message = `配置有问题：\n  - ${problems.join('\n  - ')}`;
    if (logger) logger.error(message);
    throw new Error(message);
  }

  return { config, configPath: file, generated };
}
