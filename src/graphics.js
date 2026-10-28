const fs=require('node:fs'),path=require('node:path');const{download}=require('./download');
async function resolveGraphics(version,fetchJson=async url=>{const r=await fetch(url);if(!r.ok)throw Error('Service shaders indisponible');return r.json()}){
 const list=await fetchJson('https://api.modrinth.com/v2/project/iris/version?loaders='+encodeURIComponent('["neoforge"]')+'&game_versions='+encodeURIComponent(JSON.stringify([version])));
 const iris=list.find(v=>v.version_type==='release')||list[0];if(!iris)throw Error('Aucun Iris compatible avec Minecraft '+version);
 const dependency=iris.dependencies.find(d=>d.project_id==='AANobbMI'&&d.dependency_type==='required');if(!dependency?.version_id)throw Error('Dépendance Sodium non déterminée');
 const sodium=await fetchJson('https://api.modrinth.com/v2/version/'+dependency.version_id);
 return [sodium,iris].map(v=>{if(!v.loaders.includes('neoforge')||!v.game_versions.includes(version))throw Error('Version graphique incompatible');const f=v.files.find(f=>f.primary)||v.files[0];if(!f||!/^https:\/\/cdn\.modrinth\.com\//.test(f.url)||path.basename(f.filename)!==f.filename||!f.filename.endsWith('.jar')||!/^[a-f0-9]{128}$/i.test(f.hashes?.sha512||''))throw Error('Fichier graphique non vérifiable');return{file:f.filename,url:f.url,sha512:f.hashes.sha512};});
}
async function installGraphics(root,version){
 const files=await resolveGraphics(version),dir=path.join(root,'mods'),record=path.join(root,'config','aeloria-graphics.json');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.dirname(record),{recursive:true});let previous=[];try{previous=JSON.parse(fs.readFileSync(record)).files||[]}catch{}
 const names=fs.readdirSync(dir).filter(n=>/^(iris|sodium)[-_].*\.jar$/.test(n));for(const n of names)if(!previous.includes(n)&&!files.some(f=>f.file===n))throw Error('Un mod graphique ajouté manuellement est déjà présent : '+n+'. Retire-le du dossier mods avant de continuer.');
 const stage=fs.mkdtempSync(path.join(root,'.graphics-install-')),backups=new Map(),written=[];
 try{for(const f of files)await download(f.url,path.join(stage,f.file),'sha512',f.sha512);for(const f of files){const target=path.join(dir,f.file);if(fs.existsSync(target))backups.set(target,fs.readFileSync(target));fs.copyFileSync(path.join(stage,f.file),target);written.push(target);}
  for(const n of previous)if(path.basename(n)===n&&!files.some(f=>f.file===n)&&/^(iris|sodium)[-_].*\.jar$/.test(n)){const target=path.join(dir,n);if(fs.existsSync(target)){backups.set(target,fs.readFileSync(target));fs.unlinkSync(target);}}
  const mixin=path.join(root,'config','sodium-mixins.properties');let text=fs.existsSync(mixin)?fs.readFileSync(mixin,'utf8'):'';text=text.replace(/^mixin\.features\.render\.entity=.*\r?\n?/gm,'');fs.writeFileSync(mixin,text.replace(/\s*$/,'')+'\nmixin.features.render.entity=false\n');
  fs.writeFileSync(record,JSON.stringify({minecraft:version,files:files.map(f=>f.file)},null,2));fs.mkdirSync(path.join(root,'shaderpacks'),{recursive:true});return files;
 }catch(e){for(const target of written)if(!backups.has(target)&&fs.existsSync(target))fs.unlinkSync(target);for(const[target,data]of backups)fs.writeFileSync(target,data);throw e;}
 finally{if(path.resolve(stage).startsWith(path.resolve(root)+path.sep))fs.rmSync(stage,{recursive:true,force:true});}
}
module.exports={resolveGraphics,installGraphics};
