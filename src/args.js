/** 命令行参数解析（单独一个模块，方便测试）。 */
export const HELP = `
qq-reasonix-bot —— 用 reasonix 当大脑的拟人化 QQ 机器人（走 NapCat / OneBot 11，不用 QQ 官方机器人）

用法：
  node src/index.js [选项]

选项：
  --config <path>   指定配置文件（默认 ./config.json）
  --debug           输出 debug 日志
  --probe           自检：不连 QQ，只测 reasonix 通路 + 人设效果 + 拟人化结果
  --text <内容>     配合 --probe，指定测试用的对方消息
  --group           配合 --probe，按群聊场景测试
  --web-port <端口> 网页控制台监听端口（默认 7788）
  --no-web          不启动网页控制台
  --help, -h        显示帮助
  --version, -v     显示版本

启动前检查：
  1. ./config.json 里的 onebot / reasonix / persona 段
  2. NapCat 已登录，且「反向 WebSocket」指向 ws://127.0.0.1:6700/onebot

想用网页启动/停止机器人：双击「启动控制台.bat」（或运行 node src/launcher.js）
`;

export function parseArgs(argv) {
  const options = {
    config: null,
    debug: false,
    probe: false,
    text: null,
    group: false,
    help: false,
    version: false,
    webPort: undefined,
    noWeb: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') options.config = argv[++i] ?? null;
    else if (arg === '--debug') options.debug = true;
    else if (arg === '--probe' || arg === '--selftest') options.probe = true;
    else if (arg === '--text') options.text = argv[++i] ?? null;
    else if (arg === '--group') options.group = true;
    else if (arg === '--web-port') {
      const value = Number(argv[++i]);
      if (Number.isInteger(value) && value > 0) options.webPort = value;
    } else if (arg === '--no-web') options.noWeb = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg.startsWith('-')) options.unknown = arg;
  }
  return options;
}
