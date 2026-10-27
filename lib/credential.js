/**
 * credential.js — 登录凭据的加密存取（Windows DPAPI，CurrentUser 作用域）。
 *
 * 设计红线：
 *   - 明文凭据只出现在「本地 setup 脚本的 stdin」和「进程内存」里，
 *     不进 argv、不进日志、不进任何模型可见的工具返回值。
 *   - 加密文件只有当前 Windows 账户能解密（DPAPI），拷走也没用。
 *   - 加解密通过 powershell.exe 的 stdin 完成（零 npm 依赖），PS 脚本纯 ASCII。
 *
 * 文件：$DSH_HOME/storages/dsh-novel-buddy/credential.bin（base64(DPAPI(json))）
 *       json = { username, cookie, savedAt }
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN_ID = 'dsh-novel-buddy';

export function credentialFile() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'storages', PLUGIN_ID, 'credential.bin');
}

// 注意保持纯 ASCII，避免 PowerShell 5.1 的无 BOM 编码坑
const PS_ENCRYPT =
  'Add-Type -AssemblyName System.Security; ' +
  '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
  '[Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)))';

const PS_DECRYPT =
  'Add-Type -AssemblyName System.Security; ' +
  '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
  '[Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)))';

/** 通过 stdin 传数据给 powershell，返回 stdout。凭据不进 argv。 */
function powershellB64(script, stdinB64) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error(`powershell DPAPI 调用失败: ${error.message}`));
        else resolve(stdout.trim());
      },
    );
    child.stdin.write(stdinB64);
    child.stdin.end();
  });
}

/** 加密并写入凭据文件。 */
export async function saveCredential({ username, cookie }) {
  const payload = Buffer.from(
    JSON.stringify({ username: username ?? '', cookie: cookie ?? '', savedAt: new Date().toISOString() }),
    'utf8',
  ).toString('base64');
  const cipher = await powershellB64(PS_ENCRYPT, payload);
  const file = credentialFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, cipher, 'utf8');
}

/** 读取并解密凭据。仅在插件内部发登录请求时使用；失败返回 null。 */
export async function loadCredential() {
  const file = credentialFile();
  if (!fs.existsSync(file)) return null;
  try {
    const cipher = fs.readFileSync(file, 'utf8').trim();
    const plainB64 = await powershellB64(PS_DECRYPT, cipher);
    return JSON.parse(Buffer.from(plainB64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function deleteCredential() {
  const file = credentialFile();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function hasCredentialFile() {
  return fs.existsSync(credentialFile());
}

/** 工具可见的脱敏视图：永远不含 cookie 原文。 */
export function maskUsername(username) {
  const u = String(username ?? '').trim();
  if (!u) return '（未记用户名）';
  if (u.length <= 4) return u[0] + '***';
  return u.slice(0, 3) + '***' + u.slice(-2);
}

export async function checkCredential() {
  if (!hasCredentialFile()) return { configured: false };
  const cred = await loadCredential();
  if (!cred) return { configured: false, broken: true };
  return { configured: true, username: maskUsername(cred.username), savedAt: cred.savedAt };
}
