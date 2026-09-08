import { mkdirSync,cpSync,existsSync,renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.resolve(process.argv[2] || path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'skills'),'meeting-workbench');
if(existsSync(target)) {
  const backupRoot=path.join(root,'data','skill-backups');mkdirSync(backupRoot,{recursive:true,mode:0o700});
  const backup=path.join(backupRoot,`meeting-workbench-${Date.now()}`);renameSync(target,backup);console.log(`已保留原版本：${backup}`);
}
mkdirSync(path.dirname(target),{recursive:true});
cpSync(path.join(root,'skills/meeting-workbench'),target,{recursive:true});
console.log(`Skill 已安装：${target}`);
