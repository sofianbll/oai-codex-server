#!/usr/bin/env python3
"""Local UI checks. set_content is used because this environment blocks navigation.
These test the documentation tool only, never OpenAI / Codex backends.
"""
from __future__ import annotations
import json, os, time
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
results=[];errors=[]
def check(name,condition,detail=''):
    assert condition, name+': '+detail
    results.append({'test':name,'status':'PASS','detail':detail})
def route(page,value):
    page.evaluate('(v)=>{location.hash=v;render();}',value)
    page.wait_for_timeout(40)
with sync_playwright() as p:
    executable=os.getenv('CHROMIUM_PATH') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else p.chromium.executable_path)
    browser=p.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1512,'height':1000},device_scale_factor=1)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content((ROOT/'index.html').read_text())
    check('Overview renders',page.locator('h1').count()==1 and 'contrat' in page.locator('h1').inner_text())
    check('Counts computed from data',page.locator('.stat-number').all_text_contents()==['366','46','32','0'])
    page.screenshot(path=str(ROOT/'tests/desktop.png'),full_page=True)
    page.locator('[data-nav=parameter]').click()
    page.locator('#filter-query').fill('prompt_cache_key')
    check('Parameter search filters',page.locator('#results tbody tr').count()>=1 and page.locator('#results tbody tr').count()<30)
    page.locator('#results tbody a.name').first.click()
    page.locator('.provenance').first.wait_for()
    check('Entry provenance displayed',page.locator('.provenance').count()==2 and page.locator('h1').count()==1)
    page.locator('[data-detail-tab=json]').click()
    check('Audit JSON tab',page.locator('#entry-content pre').count()==1 and 'originChain' in page.locator('#entry-content pre').inner_text())
    page.locator('[data-detail-tab=tests]').click()
    check('Unexecuted backend tests labelled', 'aucun résultat' in page.locator('#entry-content').inner_text().lower())
    route(page,'explore/endpoint')
    page.locator('[data-filter=family]').select_option('Images')
    check('Family filter',page.locator('#results tbody tr').count()==2)
    with page.expect_download() as d:
        page.locator('[data-export=filtered-json]').click()
    json_path=ROOT/'tests/download-selection.json';d.value.save_as(json_path)
    exported=json.loads(json_path.read_text())
    check('JSON export matches filter',len(exported['entries'])==2 and all(e['family']=='Images' for e in exported['entries']))
    with page.expect_download() as d:
        page.locator('[data-export=filtered-csv]').click()
    csv_path=ROOT/'tests/download-selection.csv';d.value.save_as(csv_path)
    check('CSV export',csv_path.read_text().count('\n')>=2)
    page.locator('[data-action=reset-filters]').click()
    check('Reset filters',page.locator('#results tbody tr').count()==30)
    page.locator('[data-page="2"]').click()
    check('Pagination',page.locator('#results tbody tr').count()==16)
    page.keyboard.press('Control+k')
    page.locator('#global-query').fill('x-codex-turn-state')
    check('Global search',page.locator('#global-results a').count()>=1)
    page.keyboard.press('Enter')
    page.wait_for_timeout(80)
    check('Global search opens entry',page.locator('#search-modal').count()==0 and 'turn-state' in page.locator('h1').inner_text())
    route(page,'entry/ep-control-list_tasks')
    check('No invented public route for Codex extensions','/v1null' not in page.locator('#main').inner_text() and 'Pas d’équivalent public établi' in page.locator('#main').inner_text())
    route(page,'schemas')
    page.locator('[data-action=load-demo]').click()
    page.locator('[data-schema-tab=fields]').click()
    check('Nested schema inventory',page.locator('#schema-output tbody tr').count()==8)
    page.locator('[data-schema-tab=trace]').click()
    check('Cycle reporting','cycle' in page.locator('#schema-output').inner_text())
    page.locator('#schema-file').set_input_files(str(ROOT/'tests/fixture-openapi.json'))
    page.wait_for_timeout(80)
    check('Import real local file',page.locator('.schema-imported').inner_text().startswith('fixture-openapi.json'))
    fixture=json.loads((ROOT/'tests/fixture-openapi.json').read_text())
    fixture['components']['schemas']['Base']['properties']['model']['minLength']=1
    (ROOT/'tests/fixture-openapi-v2.json').write_text(json.dumps(fixture))
    page.locator('#schema-diff-file').set_input_files(str(ROOT/'tests/fixture-openapi-v2.json'))
    page.wait_for_timeout(80)
    check('Transitive resolved schema diff','minLength' in page.locator('#schema-output').inner_text())
    page.locator('[data-schema-tab=resolved]').click()
    page.screenshot(path=str(ROOT/'tests/schema.png'),full_page=True)
    # Route smoke tests and every generated entry renderer (no invented endpoint calls).
    for r in ['overview','explore/endpoint','explore/parameter','explore/event','explore/header','explore/capability','explore/tool','explore/runtime','architecture','schemas','roadmap','sources','experiments']:
        route(page,r);assert page.locator('h1').count()==1,r
    check('All 13 main views render',True)
    all_entries=page.evaluate("()=>{for(const e of E){const h=entry(e.id);if(!h.includes('contract-pair')||h.includes('/v1null'))throw Error(e.id);}return E.length;}")
    check('Every record detail renders',all_entries==366,'366 detail templates exercised')
    route(page,'sources');page.locator('#source-search').fill('common.rs')
    check('Source search',page.locator('.source-card').count()==1)
    route(page,'roadmap');page.locator('#lot-1 summary').click()
    check('Roadmap expandable lots',page.locator('#lot-1 details').get_attribute('open') is not None)
    route(page,'entry/p-response-input');page.screenshot(path=str(ROOT/'tests/detail.png'),full_page=True)
    page.evaluate("document.querySelector('.toast')?.remove();applyTheme('dark')")
    check('Dark mode',page.locator('html').get_attribute('data-theme')=='dark')
    page.screenshot(path=str(ROOT/'tests/desktop-dark.png'),full_page=True)
    page.evaluate("applyTheme('light')")
    # Mobile and overflow checks.
    mobile=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1,is_mobile=True,has_touch=True)
    mobile.on('pageerror',lambda e:errors.append(str(e)))
    mobile.set_content((ROOT/'index.html').read_text())
    mobile.locator('#menu-btn').click()
    check('Mobile drawer opens',mobile.locator('#sidebar').evaluate("e=>e.classList.contains('open')"))
    mobile.locator('[data-nav=endpoint]').click()
    mobile.wait_for_timeout(200)
    check('Mobile nav closes drawer',not mobile.locator('#sidebar').evaluate("e=>e.classList.contains('open')"))
    check('Mobile table rows accessible',mobile.locator('#results tbody a.name').count()>0)
    mobile.screenshot(path=str(ROOT/'tests/mobile-matrix.png'),full_page=True)
    for r in ['overview','explore/parameter','entry/p-response-input','sources','roadmap','schemas']:
        route(mobile,r)
        check('Mobile no horizontal page overflow: '+r,mobile.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'))
    route(mobile,'overview');mobile.screenshot(path=str(ROOT/'tests/mobile.png'),full_page=True)
    check('No JavaScript page errors',not errors,'; '.join(errors))
    browser.close()
report={'suite':'documentation-ui','backendCalls':0,'environment':'Chromium, local set_content; network navigation blocked by environment policy','passed':len(results),'failed':0,'checks':results,'consoleErrors':errors}
(ROOT/'tests/ui-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'passed':len(results),'failed':0,'backendCalls':0}))
