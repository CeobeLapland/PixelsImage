/**
 * CLI 的可执行入口：只做一件事 —— 把参数交给 runCli，并把结果变成退出码。
 *
 * 之所以和 index.ts 分开：测试会 import index.ts 里的函数，
 * 如果退出码逻辑写在 index.ts 顶层，跑测试就会顺手把进程退出掉。
 */

import { runCli } from './index';

process.exitCode = runCli(process.argv.slice(2)).code;
