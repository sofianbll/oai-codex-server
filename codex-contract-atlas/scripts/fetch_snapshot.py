#!/usr/bin/env python3
"""Fetch public source bytes at real Git commit SHAs; never calls a Codex backend.

Requires Python 3.10+. PyYAML is optional when upstream only supplies YAML.
An optional GITHUB_TOKEN is sent only to api.github.com for commit resolution.
Existing audit mappings are NOT silently declared valid against the new snapshot.
"""
from __future__ import annotations
import argparse, concurrent.futures, datetime as dt, hashlib, json, os, re, sys
from pathlib import Path
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler

ROOT=Path(__file__).resolve().parents[1]
class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).hostname != urlsplit(req.full_url).hostname:
            raise RuntimeError('Cross-host redirect refused; review source manually.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)
OPENER=build_opener(SafeRedirect())
def fetch(url:str)->bytes:
    headers={'User-Agent':'codex-contract-atlas-source-audit/0.1','Accept':'application/vnd.github+json' if urlsplit(url).hostname=='api.github.com' else '*/*'}
    if urlsplit(url).hostname=='api.github.com' and os.getenv('GITHUB_TOKEN'):
        headers['Authorization']='Bearer '+os.environ['GITHUB_TOKEN']
    with OPENER.open(Request(url,headers=headers),timeout=30) as response:
        data=response.read(32*1024*1024+1)
    if len(data)>32*1024*1024:raise ValueError('Source exceeds 32 MiB safety limit.')
    return data

def resolve_commit(repo:str,ref:str)->str:
    payload=json.loads(fetch('https://api.github.com/repos/'+repo+'/commits/'+quote(ref,safe='')))
    sha=payload.get('sha','')
    if not re.fullmatch(r'[0-9a-f]{40}',sha):raise ValueError('No full SHA returned for '+repo)
    return sha

def main()->int:
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out',default='snapshot');ap.add_argument('--codex-ref',default='main');ap.add_argument('--openapi-ref',default='main');ap.add_argument('--workers',type=int,default=4)
    args=ap.parse_args();out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
    sources=json.loads((ROOT/'data/sources.json').read_text())
    refs={'openai/codex':args.codex_ref,'openai/openai-openapi':args.openapi_ref}
    repos={s['repo'] for s in sources if s.get('repo') and re.fullmatch(r'[^/]+/[^/]+',s['repo']) and s.get('path')}
    now=dt.datetime.now(dt.timezone.utc).isoformat();commits={};errors=[]
    for repo in sorted(repos):
        try:commits[repo]=resolve_commit(repo,refs.get(repo,'main'));print(repo,commits[repo])
        except Exception as e:errors.append({'repo':repo,'stage':'commit_resolution','error':str(e)})
    def collect(s):
        repo=s.get('repo');path=s.get('path');base={'sourceId':s['id'],'repo':repo,'path':path,'requestedRef':refs.get(repo,'main'),'collectedAt':now}
        if not repo or not path:return dict(base,status='not_fetched',reason='Documentation URL, not a repository file.')
        if repo not in commits:return dict(base,status='failed',reason='Commit unresolved.')
        if '..' in Path(path).parts or Path(path).is_absolute():return dict(base,status='failed',reason='Unsafe path.')
        candidates=['openapi.json','openapi.yaml'] if s['id']=='openapi' else [path]
        failures=[]
        for candidate in candidates:
            url=f'https://raw.githubusercontent.com/{repo}/{commits[repo]}/{quote(candidate,safe="/")}'
            try:
                content=fetch(url);destination=out/repo/candidate;destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(content)
                result=dict(base,status='fetched',path=candidate,commit=commits[repo],url=url,localPath=str(destination.relative_to(out)),sha256=hashlib.sha256(content).hexdigest(),bytes=len(content))
                if s['id']=='openapi':
                    if candidate.endswith('.json'):document=json.loads(content)
                    else:
                        try:import yaml
                        except ImportError:raise RuntimeError('YAML fetched; install PyYAML to create openapi.json.')
                        document=yaml.safe_load(content)
                    converted=json.dumps(document,ensure_ascii=False,indent=2).encode();(out/'openapi.json').write_bytes(converted)
                    result['normalizedJson']={'path':'openapi.json','sha256':hashlib.sha256(converted).hexdigest(),'note':'Parsed/reformatted representation; source byte hash is separate.'}
                return result
            except Exception as e:failures.append({'url':url,'error':str(e)})
        return dict(base,status='failed',attempts=failures)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,min(args.workers,8))) as pool:results=list(pool.map(collect,sources))
    manifest={'collectedAt':now,'commits':commits,'commitErrors':errors,'sources':results,'auditMappingRevalidated':False,'backendCalls':0}
    (out/'source-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    fetched=sum(r['status']=='fetched' for r in results);failed=sum(r['status']=='failed' for r in results)
    print(f'{fetched} files fetched; {failed} failures. Manifest: {out / "source-manifest.json"}')
    if errors or failed:return 2
    return 0
if __name__=='__main__':sys.exit(main())
