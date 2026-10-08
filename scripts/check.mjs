import { readdirSync,readFileSync,existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const files=[];
function walk(dir){if(!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(/\.(js|mjs)$/.test(p))files.push(p);}}
for(const dir of ['server','shared','mcp','scripts','test','public'])walk(dir);
for(const file of files){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status){process.stderr.write(r.stderr);process.exit(1);}}
for(const file of ['.gitignore','.env.example','README.md','CONTRIBUTING.md','SECURITY.md','docs/SCREENSHOTS.md','docs/assets/cover.svg','docs/assets/workflow.svg','docs/assets/screenshot-focus.png','docs/assets/screenshot-topics.png','docs/assets/speaker-identification.svg','LICENSE','NOTICE.md','docs/GETTING_STARTED.md','skills/meeting-workbench/SKILL.md']) if(!existsSync(file))throw new Error(`缺少 ${file}`);
const skill=readFileSync('skills/meeting-workbench/SKILL.md','utf8');if(!skill.startsWith('---\n') || !skill.includes('name: meeting-workbench'))throw new Error('Skill frontmatter invalid');
console.log(`语法检查通过：${files.length} 个模块；交付文件齐全。`);
