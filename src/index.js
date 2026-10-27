#!/usr/bin/env node
/**
 * 入口。
 *   node src/index.js              启动机器人
 *   node src/index.js --probe      只测「reasonix 通路 + 人设 + 拟人化」，不连 QQ
 *   node src/index.js --debug      打开 debug 日志
 */
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { HELP, parseArgs } from './args.js';
import { PROJECT_ROOT, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildTaskPrompt, preparePersona } from './persona.js';
import { ReasonixRunner } from './reasonix.js';
import { QQBot } from './bot.js';
import { buildSendPlan } from './humanize.js';
import { StickerStore } from './stickers.js';
import { WebConsole } from './web.js';

async function probe({ config, logger, dataDir, text, group }) {
  const personaDir = preparePersona({ config, dataDir, logger });
  const runner = new ReasonixRunner({ config, logger, personaDir });
  const stickers = new StickerStore({ config, logger });
  stickers.ensureDirs();
  stickers.refresh();
  const stickerHint = stickers.enabled ? stickers.describe() : '';

  const sample = text ?? (group ? '@你 你昨天说的那个 bug 修好了吗' : '在吗，忙不忙');
  const context = group
    ? {
        kind: 'group',
        groupId: '123456789',
        groupName: '测试群',
        history: [
          { speaker: '小明', isSelf: false, text: '有人吗', time: Date.now() - 180000 },
          { speaker: config.persona.name, isSelf: true, text: '在', time: Date.now() - 170000 },
        ],
        batch: [{ speaker: '小明', isSelf: false, text: sample, atSelf: true, time: Date.now() }],
      }
    : {
        kind: 'private',
        history: [],
        batch: [{ speaker: '小明', isSelf: false, text: sample, atSelf: false, time: Date.now() }],
      };

  const prompt = buildTaskPrompt({ config, context, stickers: stickerHint });
  if (stickerHint) console.log(`\n可用表情包：${stickerHint}`);
  console.log('\n===== 发给 reasonix 的提示词 =====\n');
  console.log(prompt);
  console.log('\n===== reasonix 思考中… =====\n');

  const startedAt = Date.now();
  try {
    const result = await runner.run({ chatKey: 'probe', prompt });
    const elapsed = Date.now() - startedAt;
    console.log(`原始输出（${elapsed}ms）：\n${result.text}\n`);

    const plan = buildSendPlan({
      rawText: result.text,
      config,
      elapsedMs: elapsed,
      resolveSticker: (name) => stickers.resolve(name),
    });
    if (plan.unknownStickers?.length) {
      console.log(`⚠️ 模型想发不存在的表情包：${plan.unknownStickers.join('、')}（会被忽略）`);
    }
    if (plan.skip) {
      console.log(`拟人化结果：这次不回（${plan.reason}）`);
    } else {
      console.log('拟人化结果（这就是实际会发到 QQ 的样子）：');
      for (const [index, part] of plan.parts.entries()) {
        const what = part.kind === 'sticker' ? `【表情包：${part.name}】` : part.text;
        console.log(`  第 ${index + 1} 条（等 ${(part.delayMs / 1000).toFixed(1)}s 再发）：${what}`);
      }
    }
    console.log(`\n${runner.summary()}`);
  } catch (error) {
    console.error(`\n自检失败：${error.message}`);
    process.exitCode = 1;
  } finally {
    await runner.stop();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.unknown) {
    console.warn(`未知参数 ${options.unknown}，已忽略（用 --help 查看可用参数）`);
  }
  if (options.version) {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    console.log(pkg.default.version);
    return;
  }

  const bootstrapLogger = createLogger({ level: 'warn', dir: null, console: true });
  const { config, configPath } = loadConfig({ configPath: options.config, logger: bootstrapLogger });
  if (options.debug) config.log.level = 'debug';
  // 命令行可以覆盖网页控制台的端口（控制台模式下机器人跑在 7789，由控制台占 7788 转发）
  if (options.webPort !== undefined) {
    config.web.port = options.webPort;
    config.web.enabled = true;
  }
  if (options.noWeb) config.web.enabled = false;
  const dataDir = path.join(PROJECT_ROOT, 'data');
  const logger = createLogger({
    level: config.log.level,
    dir: path.isAbsolute(config.log.dir) ? config.log.dir : path.join(PROJECT_ROOT, config.log.dir),
    console: config.log.console,
  });

  logger.info(`配置文件：${configPath}`);
  logger.info(`工作目录：${PROJECT_ROOT}`);

  if (config.trigger.group.enabled && !(config.trigger.group.nicknames ?? []).includes(config.persona.name)) {
    logger.warn(
      `trigger.group.nicknames 里没有机器人的人设名字「${config.persona.name}」，群里叫这个名字时它不会应（要的话把名字加进去）`,
    );
  }

  if (options.probe) {
    await probe({ config, logger, dataDir, text: options.text, group: options.group });
    return;
  }

  const bot = new QQBot({ config, logger, dataDir });

  let web = null; // 下面启动；退出时要先关掉
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在退出…`);
    try {
      if (web) await web.stop();
      await bot.stop();
    } catch (error) {
      logger.error('退出时出错：', error);
    }
    logger.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('未处理的 Promise 拒绝：', reason));
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常：', error);
  });

  // 先把控制台开起来：它不依赖 QQ 连接，你可以一边等 NapCat 一边看状态
  web = new WebConsole({ bot, config, logger });
  let webUrl = null;
  try {
    webUrl = await web.start();
  } catch (error) {
    logger.error(`Web 控制台启动失败（不影响机器人本身）：${error.message}`);
  }

  if (webUrl) {
    logger.info(`控制台：${webUrl}`);
    if (config.web?.open) {
      spawn('cmd', ['/c', 'start', '', webUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref?.();
    }
  }

  await bot.start();
  logger.info('机器人已就绪。按 Ctrl+C 退出。');
}

main().catch((error) => {
  console.error(`启动失败：${error?.stack ?? error}`);
  process.exit(1);
});
