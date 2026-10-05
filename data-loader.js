// Static-data discovery/loading helpers extracted from app.js.

import {parseCifStructure} from "./cif-structure.js";

export async function fetchJson(url){
  const response = await fetch(url, {cache: "no-store"});

  if(!response.ok){
    throw new Error(`${url} を読み込めませんでした (HTTP ${response.status})。`);
  }

  return await response.json();
}

export function normalizeJsonFileList(value){
  if(Array.isArray(value)){
    return value.map(String);
  }

  // Optional alternative manifest format:
  // { "files": ["a.json", "b.json"] }
  if(value && Array.isArray(value.files)){
    return value.files.map(String);
  }

  throw new Error("index.json は JSON ファイル名の配列、または {files:[...]} である必要があります。");
}

export function isGitHubPages(){ return window.location.hostname.endsWith("github.io"); }
export function isLocalDirectoryListingHost(){
  return ["localhost","127.0.0.1","::1"].includes(window.location.hostname);
}

export async function discoverJsonFilesFromGitHub(directory){
  const owner=window.location.hostname.split('.')[0];
  const parts=window.location.pathname.split('/').filter(Boolean);
  const repo=parts[0];
  if(!repo) throw new Error("GitHub Pages repository name could not be inferred. Add directory/index.json.");
  const apiUrl=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${directory}`;
  const response=await fetch(apiUrl,{cache:"no-store",headers:{"Accept":"application/vnd.github+json"}});
  if(!response.ok) throw new Error(`GitHub API: ${directory}/ (HTTP ${response.status})`);
  const items=await response.json();
  return items.filter(x=>x&&x.type==="file").map(x=>x.name).filter(x=>/\.json$/i.test(x)&&x.toLowerCase()!=="index.json").sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
}

export async function discoverJsonFilesFromDirectoryListing(directory){
  const response = await fetch(`${directory}/`, {cache: "no-store"});

  if(!response.ok){
    throw new Error(
      `${directory}/ を読み込めませんでした。` +
      ` ディレクトリがプロジェクト内にあるか確認してください。`
    );
  }

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const files = [...doc.querySelectorAll("a[href]")]
    .map(a => a.getAttribute("href"))
    .filter(Boolean)
    .map(href => {
      try{
        const url = new URL(href, window.location.href);
        return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      }catch(_err){
        return null;
      }
    })
    .filter(Boolean)
    .filter(name => /\.json$/i.test(name))
    .filter(name => name.toLowerCase() !== "index.json");

  return [...new Set(files)].sort((a,b)=>a.localeCompare(b));
}

export async function discoverJsonFiles(directory){
  // Local development with python -m http.server exposes directory listings.
  if(isLocalDirectoryListingHost()){
    const files=await discoverJsonFilesFromDirectoryListing(directory);
    if(files.length===0) throw new Error(`${directory}/ に JSON ファイルを見つけられませんでした。`);
    return files;
  }

  // GitHub Pages does not expose directory listings.  Query the repository
  // that owns the *current* Pages URL directly instead of probing an optional
  // directory/index.json first.  This both restores optional data directories
  // (BG material / sample environments) and avoids noisy manifest 404s.
  if(isGitHubPages()){
    const files=await discoverJsonFilesFromGitHub(directory);
    if(files.length===0) throw new Error(`${directory}/ に JSON ファイルがありません。`);
    return files;
  }

  // Other static hosts may provide an explicit manifest.
  try{
    const manifestResponse=await fetch(`${directory}/index.json`,{cache:"no-store"});
    if(manifestResponse.ok){
      const manifest=await manifestResponse.json();
      const files=normalizeJsonFileList(manifest)
        .filter(name=>/\.json$/i.test(name))
        .filter(name=>name.toLowerCase()!=="index.json");
      if(files.length>0) return files.sort((a,b)=>a.localeCompare(b));
    }
  }catch(_err){}

  const files=await discoverJsonFilesFromDirectoryListing(directory);
  if(files.length===0) throw new Error(`${directory}/ に JSON ファイルを見つけられませんでした。`);
  return files;
}

export async function loadJsonDirectory(directory, targetMap){
  targetMap.clear();

  const files = await discoverJsonFiles(directory);

  for(const filename of files){
    const obj = await fetchJson(`${directory}/${filename}`);
    const key = filename.replace(/\.json$/i, "");
    targetMap.set(key, obj);
  }

  return files.length;
}

export function normalizeCifFileList(value){
  if(Array.isArray(value)) return value.map(String);
  if(value && Array.isArray(value.files)) return value.files.map(String);
  throw new Error("BG_material/index.json must be an array of CIF filenames or {files:[...]}. ");
}

export async function discoverCifFilesFromGitHub(directory){
  const owner=window.location.hostname.split('.')[0];
  const parts=window.location.pathname.split('/').filter(Boolean);
  const repo=parts[0];
  if(!repo) throw new Error("GitHub Pages repository name could not be inferred. Add BG_material/index.json.");
  const apiUrl=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${directory}`;
  const response=await fetch(apiUrl,{cache:"no-store",headers:{"Accept":"application/vnd.github+json"}});
  if(!response.ok) throw new Error(`GitHub API: ${directory}/ (HTTP ${response.status})`);
  const items=await response.json();
  return items
    .filter(x=>x&&x.type==="file")
    .map(x=>x.name)
    .filter(x=>/\.cif$/i.test(x))
    .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
}

export async function discoverCifFilesFromDirectoryListing(directory){
  const response=await fetch(`${directory}/`,{cache:"no-store"});
  if(!response.ok) throw new Error(`${directory}/ could not be loaded (HTTP ${response.status}).`);
  const html=await response.text();
  const doc=new DOMParser().parseFromString(html,"text/html");
  const files=[...doc.querySelectorAll("a[href]")]
    .map(a=>a.getAttribute("href"))
    .filter(Boolean)
    .map(href=>{
      try{
        const url=new URL(href,window.location.href);
        return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop()||"");
      }catch(_err){ return null; }
    })
    .filter(Boolean)
    .filter(name=>/\.cif$/i.test(name));
  return [...new Set(files)].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
}

export async function discoverCifFiles(directory){
  // On the local Python server, the directory listing is authoritative.
  if(isLocalDirectoryListingHost()) return await discoverCifFilesFromDirectoryListing(directory);

  // On GitHub Pages, use the current repository directly.  Do not probe a
  // possibly absent BG_material/index.json, because the repository contents
  // API already gives the authoritative CIF list without a console 404.
  if(isGitHubPages()) return await discoverCifFilesFromGitHub(directory);

  // Optional manifest for other static hosts that do not expose listings.
  try{
    const response=await fetch(`${directory}/index.json`,{cache:"no-store"});
    if(response.ok){
      const manifest=await response.json();
      const files=normalizeCifFileList(manifest).filter(name=>/\.cif$/i.test(name));
      if(files.length) return files.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}));
    }
  }catch(_err){}

  return await discoverCifFilesFromDirectoryListing(directory);
}

export async function loadCifDirectory(directory,targetMap){
  targetMap.clear();
  const files=await discoverCifFiles(directory);
  const errors=[];
  for(const filename of files){
    try{
      const response=await fetch(`${directory}/${filename}`,{cache:"no-store"});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      const text=await response.text();
      const structure=parseCifStructure(text);
      const key=filename.replace(/\.cif$/i,"");
      targetMap.set(key,{key,filename,structure});
    }catch(err){
      errors.push(`${filename}: ${err?.message||err}`);
    }
  }
  if(errors.length) console.warn("BG_material CIF load warning(s):\n"+errors.join("\n"));
  return targetMap.size;
}
