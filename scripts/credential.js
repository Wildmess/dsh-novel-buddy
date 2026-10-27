#!/usr/bin/env node
/**
 * credential.js — 本地凭据管理（只有你在自己的终端里跑，不经过鱼/聊天窗口）。
 *
 *   node scripts/credential.js set      交互式录入（输入隐藏），DPAPI 加密存盘
 *   node scripts/credential.js check    查看是否已配置（只显示脱敏用户名）
 *   node scripts/credential.js forget   删除凭据
 *   node scripts/credential.js set --stdin '{"username":"...","cookie":"..."}'   （脚本/测试用）
 *
 * 录入内容：番茄小说网页版的登录 Cookie（浏览器 F12 → Network 任意请求 →
 * Request Headers 里 Cookie: 后面的整串；或用 Cookie-Editor 插件导出）。
 * Cookie 里已包含登录态；用户名只是备注，方便确认是哪个号。
 *
 * 安全：密码/Cookie 永远不要发给 AI 或粘贴进聊天；本脚本输入不回显、
 *       落盘前用 Windows DPAPI 加密（只有你的 Windows 账户能解密）。
 */

import readline from 'node:readline';
import { checkCredential, deleteCredential, hasCredentialFile, saveCredential } from '../lib/credential.js';

const command = process.argv[2] ?? '';

function questionHidden(rl, prompt) {
  return new Promise((resolve) => {
    // 关闭回显的土办法：临时替换输出函数
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      if (!s.includes(prompt)) return; // 静默一切回显
      orig(s);
    };
    rl.question(prompt, (answer) => {
      rl._writeToOutput = orig;
      resolve(answer.trim());
    });
  });
}

function question(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, (a) => resolve(a.trim())));
}

async function main() {
  if (command === 'set') {
    const stdinIdx = process.argv.indexOf('--stdin');
    if (stdinIdx > 0) {
      const raw = process.argv[stdinIdx + 1] ?? '{}';
      const parsed = JSON.parse(raw);
      await saveCredential(parsed);
      console.log('已加密保存。');
      process.exit(0);
    }
    console.log('粘贴番茄小说网页版登录 Cookie（输入不回显，回车结束）');
    console.log('获取方式：浏览器登录 fanqienovel.com → F12 → Network → 随便一个请求 → Request Headers → Cookie 整串');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const username = await question(rl, '备注用用户名/昵称（可回车跳过）: ');
    const cookie = await questionHidden(rl, 'Cookie 整串: ');
    if (!cookie) {
      console.log('Cookie 为空，未保存。');
      process.exit(1);
    }
    await saveCredential({ username, cookie });
    console.log('已加密保存到 credential.bin（DPAPI，仅当前 Windows 账户可解密）。');
    rl.close();
    process.exit(0);
  }

  if (command === 'check') {
    const state = await checkCredential();
    if (!state.configured) {
      console.log(state.broken ? '凭据文件存在但解密失败（可能换过 Windows 账户），请重新 set。' : '未配置。');
      process.exit(state.broken ? 1 : 0);
    }
    console.log(`已配置：用户名 ${state.username}（保存于 ${state.savedAt}）`);
    console.log('在线验证请在 DSH 里让鱼调 novel_credential(action=check)。');
    process.exit(0);
  }

  if (command === 'forget') {
    if (!hasCredentialFile()) {
      console.log('本来就没有凭据。');
    } else {
      deleteCredential();
      console.log('已删除。');
    }
    process.exit(0);
  }

  console.log('用法: node scripts/credential.js <set|check|forget>');
  process.exit(1);
}

main().catch((e) => {
  console.error('出错:', e.message);
  process.exit(1);
});
