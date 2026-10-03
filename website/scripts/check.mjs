import {readFile,stat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
const files=[];
async function walk(dir){for(const x of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,x.name);if(x.isDirectory())await walk(p);else if(p.endsWith('.html'))files.push(p);}}
await walk(root);
const errors=[];let references=0;
for(const file of files){const html=await readFile(file,'utf8');const rel=path.relative(root,file);
 if((html.match(/<h1[ >]/g)||[]).length!==1)errors.push(`${rel}: expected one h1`);
 for(const needle of ['<title>','name="description"','name="viewport"','rel="canonical"','lang="en"'])if(!html.includes(needle))errors.push(`${rel}: missing ${needle}`);
 for(const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)){try{JSON.parse(m[1]);}catch{errors.push(`${rel}: invalid JSON-LD`);}}
 for(const m of html.matchAll(/(?:href|src|poster)="([^"]+)"/g)){const value=m[1];if(!value.startsWith('/'))continue;references++;const url=new URL(value,'https://runo.sh');let target=path.join(root,decodeURIComponent(url.pathname));try{const s=await stat(target);if(s.isDirectory())target=path.join(target,'index.html');await stat(target);}catch{errors.push(`${rel}: missing ${value}`);}}
}
for(const file of ['robots.txt','sitemap.xml','assets/runo-diagram.svg']){try{await stat(path.join(root,file));}catch{errors.push(`missing ${file}`);}}
const robots=await readFile(path.join(root,'robots.txt'),'utf8');if(!robots.includes('Sitemap: https://runo.sh/sitemap.xml'))errors.push('missing sitemap declaration');
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log(`Checked ${files.length} HTML pages, ${references} local references, metadata, JSON-LD and media assets.`);
