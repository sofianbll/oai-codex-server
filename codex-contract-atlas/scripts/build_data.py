"""Curated source-backed audit, not an automatically extracted full upstream spec."""
from pathlib import Path
import json, csv, hashlib
BASE=Path(__file__).resolve().parents[1]
DATE='2026-09-19'
S={}
def source(id,title,path=None,url=None,kind='CODEX OSS',status='inspected',note=''):
    repo='openai/codex' if path else None
    if not url: url=f'https://github.com/{repo}/blob/main/{path}'
    S[id]=dict(id=id,title=title,url=url,repo=repo,path=path,kind=kind,status=status,revision=None,contentSha256=None,retrievedAt=DATE,revisionStatus='main non figé' if path else 'page consultée, non figée',note=note or 'Lecture du code ou de la documentation ; aucun appel backend authentifié.')
source('openapi','OpenAI OpenAPI 3.1 · YAML',url='https://github.com/openai/openai-openapi/blob/main/openapi.yaml',kind='OPENAI OPENAPI',note='Sections consultées dans le YAML officiel. Fichier intégral non embarqué. Projection éditoriale explicitement séparée du brut ; import JSON et extracteur fournis.')
S['openapi'].update(repo='openai/openai-openapi',path='openapi.yaml',revisionStatus='main non figé',rawUrl='https://raw.githubusercontent.com/openai/openai-openapi/main/openapi.yaml')
for args in [
('common','Contrats Responses HTTP / WS','codex-rs/codex-api/src/common.rs'),
('sse','Parseur SSE et métadonnées','codex-rs/codex-api/src/sse/responses.rs'),
('items','ResponseItem / ContentItem / sérialisation','codex-rs/protocol/src/models.rs'),
('input','Entrées utilisateur','codex-rs/protocol/src/user_input.rs'),
('catalog','ModelInfo et ReasoningEffort','codex-rs/protocol/src/openai_models.rs'),
('models','Découverte des modèles','codex-rs/model-provider/src/models_endpoint.rs'),
('provider','URL / modes provider','codex-rs/model-provider-info/src/lib.rs'),
('headers','Headers de session','codex-rs/codex-api/src/requests/headers.rs'),
('images','Routes Images JSON','codex-rs/codex-api/src/endpoint/images.rs'),
('imagetypes','Types Images','codex-rs/codex-api/src/images.rs'),
('imagebackend','Auth / provider Images','codex-rs/ext/image-generation/src/backend.rs'),
('imagetool','Outil imagegen et références','codex-rs/ext/image-generation/src/tool.rs'),
('rtc','Création d’appels WebRTC','codex-rs/codex-api/src/endpoint/realtime_call.rs'),
('rtcore','Auth et orchestration Realtime','codex-rs/core/src/realtime_conversation.rs'),
('rtws','Connexions Realtime et sideband','codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs'),
('rtprotocol','Types Realtime','codex-rs/codex-api/src/endpoint/realtime_websocket/protocol.rs'),
('rtv2','Session Realtime V2','codex-rs/codex-api/src/endpoint/realtime_websocket/methods_v2.rs'),
('compact','Compaction distante','codex-rs/codex-api/src/endpoint/compact.rs'),
('memories','Synthèse des traces mémoire','codex-rs/codex-api/src/endpoint/memories.rs'),
('backend','Client du control plane','codex-rs/backend-client/src/client.rs'),
('backendmodels','Modèles OpenAPI backend · sous-ensemble','codex-rs/codex-backend-openapi-models/src/models/mod.rs'),
('spawn','Exécuteur local spawn_agent V2','codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs'),
('features','Registre des features','codex-rs/features/src/lib.rs'),
]: source(*args)
source('app','Codex App Server',url='https://learn.chatgpt.com/docs/app-server',kind='OFFICIAL DOC')
source('multi','Responses Multi-agent beta',url='https://developers.openai.com/api/docs/guides/responses-multi-agent',kind='OFFICIAL DOC')
source('proxy','Proxy Responses officiel',path='codex-rs/responses-api-proxy/README.md')
source('cliproxy','CLIProxyAPI · point d’entrée',url='https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/codex_executor.go',kind='COMMUNITY SOURCE',note='Le fichier inspecté est un exécuteur très mince. Le vrai ClientAdapter et les traducteurs restent à suivre ; aucune transformation détaillée attribuée à ce seul fichier.')
source('community','codex-responses-proxy',url='https://github.com/David-Factor/codex-responses-proxy',kind='COMMUNITY SOURCE',status='to_inspect',note='Piste de reverse identifiée. Pas de conclusions de compatibilité basées sur cette source dans ce dataset.')
source('browser','Codex Browser',url='https://learn.chatgpt.com/docs/browser',kind='OFFICIAL DOC',status='prior_audit',note='Référence reprise de l’audit des capacités précédent ; révision produit non figée.')
source('computer','Codex Computer Use',url='https://learn.chatgpt.com/docs/computer-use',kind='OFFICIAL DOC',status='prior_audit',note='Référence du précédent audit ; dépendances hôte à revalider pour la surface retenue.')
source('voice','Codex Voice',url='https://learn.chatgpt.com/docs/features/voice',kind='OFFICIAL DOC',status='prior_audit',note='Référence du précédent audit ; support produit distinct du contrat backend.')
E=[]
def side(name,src,pointer=None,symbol=None,type=None,required=None,nullable=None,values=None,chain=None):
    return dict(name=name,sourceId=src,pointer=pointer,symbol=symbol,type=type,required=required,nullable=nullable,values=values,originChain=chain or ([pointer or symbol] if pointer or symbol else []))
def oa(name,schema=None,field=None,type=None,required=None,nullable=None,values=None,chain=None):
    ptr='#/components/schemas/'+schema if schema else None
    if field: ptr+='/properties/'+field.replace('~','~0').replace('/','~1')
    return side(name,'openapi',ptr,type=type,required=required,nullable=nullable,values=values,chain=chain)
def cx(name,src,symbol=None,type=None,required=None,nullable=None,values=None):
    return side(name,src,symbol=symbol or name,type=type,required=required,nullable=nullable,values=values,chain=[S[src].get('path') or S[src]['title'],symbol or name])
def add(id,category,family,name,openai=None,codex=None,mapping='candidate',where='BACKEND_NATIVE',transport=('HTTP','SSE'),lot=1,confidence='HIGH',notes='',transform='Relayer le sous-ensemble validé sans reconstruire le JSON.',risk='medium',rc=2,ic=2,tests=None,scope=None,**extra):
    entry=dict(id=id,category=category,family=family,name=name,openai=openai,codex=codex,mapping=mapping,executionLocation=where,transport=list(transport),lot=lot,confidence=confidence,evidenceBasis='schema + code' if openai and codex else 'code' if codex else 'schema',liveVerified=False,scope=scope or ('OPENAI_AND_CODEX_REVIEWED' if openai and codex else ('CODEX_EXTENSION' if mapping == 'codex_only' else 'PUBLIC_MAPPING_NOT_ESTABLISHED') if codex else 'OPENAI_STANDARD'),transformation=transform,lossRisk=risk,researchComplexity=rc,implementationComplexity=ic,maintenanceRisk=risk,notes=[notes] if isinstance(notes,str) and notes else notes or [],authRequirements='Authentification légitime du provider ; accès du compte non testé.',modelRequirements='À déterminer dans le catalogue du compte, puis par test authentifié.',tests=tests or ['Comparer un appel direct autorisé et un appel via la façade : requête, réponse, erreurs et métadonnées.'],**extra)
    E.append(entry); return entry
ROOT='#/paths/~1responses/post/requestBody/content/application~1json/schema'
# Full root field inventory of the inspected CreateResponse hierarchy, manually reviewed.
# A field's absence from the Codex struct is NOT a proof of rejection by its server.
fields=[
('model','ResponseProperties','string','String','model',None,None,'candidate',1,'Le modèle doit venir du catalogue, pas d’une liste figée.'),
('input','CreateResponse','string | InputParam (tableau)','Vec<ResponseItem>','input',None,None,'translation',1,'La forme tableau commune peut être relayée ; la forme chaîne publique doit devenir un message seulement si le backend l’exige.'),
('instructions','CreateResponse','string | null','String','instructions',None,True,'candidate',1,'Codex omet la chaîne vide. Omission, null et chaîne vide ne sont pas interchangeables par défaut.'),
('tools','ResponseProperties','ToolsArray','Option<ResponsesApiTools>','tools',None,None,'candidate',1,'ResponsesApiTools conserve du JSON brut via Arc<RawValue> ; ne pas remplacer les outils inconnus.'),
('tool_choice','ResponseProperties','ToolChoiceParam','String','tool_choice',None,None,'translation',1,'Codex typé utilise String ; les formes objet publiques doivent être préservées au niveau brut ou explicitement refusées si rejetées.'),
('parallel_tool_calls','CreateResponse','boolean | null','bool','parallel_tool_calls',None,True,'candidate',1,'Distinguer valeur booléenne, omission, null et valeur par défaut backend.'),
('reasoning','CreateResponse','Reasoning | null','Option<Reasoning>','reasoning',None,True,'candidate',1,'Comparer les champs imbriqués ; ne pas confondre résumé et état chiffré.'),
('store','CreateResponse','boolean | null','bool','store',None,True,'candidate',1,'API publique : défaut true. Le type Codex contient store ; les valeurs acceptées et la rétention backend restent à mesurer.'),
('stream','CreateResponse','boolean | null','bool','stream',None,True,'candidate',1,'API publique : défaut false. Si le backend impose le streaming, le mode JSON exige une agrégation explicitement testée.'),
('stream_options','CreateResponse','ResponseStreamOptions','Option<StreamOptions>','stream_options',None,None,'candidate',1,'Le type Codex inspecté ne couvre qu’une option de livraison des résumés.'),
('include','CreateResponse','string[] | null','Vec<String>','include',None,True,'candidate',1,'Préserver les valeurs futures. Ne pas déduire l’accessibilité de tous les includes publics.'),
('service_tier','CreateResponse','ServiceTierResponses','Option<String>','service_tier',None,None,'candidate',2,'Ne pas substituer des niveaux tarifaires ou de priorité. Catalogue et compte font foi.'),
('prompt_cache_key','ModelResponseProperties','string | null','Option<String>','prompt_cache_key',False,True,'candidate',3,'Clé de routage/cache, pas une exportation du KV cache ni un identifiant de conversation.'),
('text','ResponseProperties','ResponseTextParam','Option<TextControls>','text',None,None,'candidate',1,'La sortie structurée possède format/type/name/schema/strict ; voir champs imbriqués.'),
('previous_response_id','ResponseProperties','string | null',None,None,False,True,'unknown',3,'Présent côté API publique HTTP, absent de ResponsesApiRequest inspecté ; présent côté WS Codex dans une entrée distincte.'),
('background','ResponseProperties','boolean | null',None,None,False,True,'unknown',3,'Ne pas émuler automatiquement les garanties d’un traitement serveur en tâche de fond.'),
('max_tool_calls','ResponseProperties','integer | null',None,None,False,True,'unknown',3,'Non émis par ce type Codex ; ce constat ne prouve pas un rejet backend.'),
('prompt','ResponseProperties','Prompt',None,None,False,None,'unknown',3,'Prompts hébergés/versionnés : équivalence backend non établie.'),
('max_output_tokens','CreateResponse','integer >=16 | null',None,None,False,True,'unknown',3,'Paramètre hérité/root à ne pas supprimer silencieusement. Tester son acceptation et son application réelle.'),
('conversation','CreateResponse','ConversationParam | null',None,None,False,True,'unknown',3,'Un thread Codex local n’est pas une ressource publique Conversations.'),
('context_management','CreateResponse','ContextManagementParam[] | null',None,None,False,True,'unknown',3,'Ne pas assimiler réglage backend, compaction automatique locale et endpoint compact.'),
('truncation','CreateResponse','auto | disabled | null',None,None,False,True,'unknown',3,'Déprécié dans la section CreateResponse inspectée ; pas de suppression silencieuse.'),
('moderation','CreateResponse','ModerationParam | null',None,None,False,True,'unknown',3,'Paramètre public ; traitement Codex non confirmé. Préserver les protections et refus serveur.'),
('metadata','ModelResponseProperties','Metadata',None,None,False,None,'unknown',3,'metadata public et client_metadata Codex ne sont pas automatiquement des alias.'),
('temperature','ModelResponseProperties','number [0,2] | null',None,None,False,True,'unknown',3,'Disponible dans le schéma public, support selon modèle/route. Non émis par le type Codex inspecté.'),
('top_p','ModelResponseProperties','number [0,1] | null',None,None,False,True,'unknown',3,'Même frontière que temperature ; vérifier l’effet et pas seulement HTTP 200.'),
('top_logprobs','CreateModelResponseProperties','integer [0,20]',None,None,False,False,'unknown',3,'Contraintes cumulées de ModelResponseProperties et CreateModelResponseProperties : ne pas fusionner par écrasement.'),
('user','ModelResponseProperties','string',None,None,False,None,'unknown',3,'Déprécié publiquement ; remplacé par safety_identifier et prompt_cache_key, rôles distincts.'),
('safety_identifier','ModelResponseProperties','string <=64 | null',None,None,False,True,'unknown',3,'Ne pas convertir un identifiant de sécurité en account ID ni en clé de cache.'),
('prompt_cache_retention','ModelResponseProperties','in_memory | 24h | null',None,None,False,True,'unknown',3,'Déprécié ; politique maximale de rétention, différente de la durée minimale ttl.'),
('prompt_cache_options','CreateResponse','ResponsePromptCacheOptionsParam',None,None,False,None,'unknown',3,'Déclaration à plusieurs niveaux allOf ; garder les contraintes cumulées. Acceptation Codex à vérifier.'),
]
for i,(name,sch,ot,ct,cf,req,null,mapping,lot,note) in enumerate(fields):
    prop=('#/components/schemas/'+sch+('/allOf/2' if sch=='CreateResponse' else '/allOf/1' if sch=='CreateModelResponseProperties' else '')+'/properties/'+name)
    chain=[ROOT,'#/components/schemas/CreateResponse']
    if sch in ('CreateModelResponseProperties','ModelResponseProperties'): chain+=['#/components/schemas/CreateResponse/allOf/0','#/components/schemas/CreateModelResponseProperties']
    if sch=='ModelResponseProperties': chain+=['#/components/schemas/CreateModelResponseProperties/allOf/0','#/components/schemas/ModelResponseProperties']
    if sch=='ResponseProperties': chain+=['#/components/schemas/CreateResponse/allOf/1','#/components/schemas/ResponseProperties']
    chain+=[prop]
    o=side(name,'openapi',prop,type=ot,required=req,nullable=null,chain=chain)
    c=cx(name,'common','ResponsesApiRequest.'+cf,type=ct) if ct else None
    add('p-response-'+name,'parameter','Responses',name,o,c,mapping=mapping,lot=lot,notes=note,confidence='HIGH' if ct else 'UNKNOWN',risk='high' if mapping=='unknown' else 'medium',requirednessNote='Aucune liste required au niveau CreateResponse observé ; les contraintes des variantes/références doivent être résolues séparément.')
# Known nested fields, each source-specific. Values for actual accounts deliberately not hard-coded.
nested=[
('reasoning.effort','Reasoning','effort','ReasoningEffort','Option<ReasoningEffortConfig>','Reasoning.effort','superset','Codex connaît ultra, persistent et Custom(String), au-delà de l’enum publique inspectée. Ne pas les activer sans catalogue.', ['none','minimal','low','medium','high','xhigh','max']),
('reasoning.summary','Reasoning','summary','auto | concise | detailed | null','Option<ReasoningSummary>','Reasoning.summary','candidate','Sous-ensemble commun ; disponibilité modèle et incompatibilités multi-agent à valider.', ['auto','concise','detailed']),
('reasoning.context','Reasoning','context','auto | current_turn | all_turns | null','Option<ReasoningContext>','Reasoning.context','candidate','Ce champ est aussi dans le schéma PUBLIC consulté, pas exclusivement Codex.', ['auto','current_turn','all_turns']),
('reasoning.mode','Reasoning','mode','ReasoningModeEnum',None,None,'unknown','Présent dans le schéma public consulté ; type Reasoning Codex inspecté sans ce champ.',None),
('reasoning.generate_summary','Reasoning','generate_summary','auto | concise | detailed | null',None,None,'unknown','Déprécié côté public. Ne pas inventer un alias sans règles de priorité.',None),
('text.format','ResponseTextParam','format','TextResponseFormatConfiguration','Option<TextFormat>','TextControls.format','candidate','Conserver la structure JSON Schema et les alternatives, pas uniquement type.',None),
('text.verbosity','ResponseTextParam','verbosity','low | medium | high','Option<Verbosity>','TextControls.verbosity','candidate','Valeurs communes ; support réel dépend du catalogue.', ['low','medium','high']),
('text.format.type',None,None,'json_schema','json_schema','TextFormat.type','identical','Identité limitée au discriminant json_schema. Les autres formats publics demandent leur propre vérification.',['json_schema']),
('text.format.name',None,None,'string','String','TextFormat.name','candidate','Codex peut fabriquer codex_output_schema ; un proxy ne doit pas remplacer le nom entrant.',None),
('text.format.schema',None,None,'JSON Schema','serde_json::Value','TextFormat.schema','candidate','Conserver $ref, required, unions et mots-clés inconnus. Ne pas aplatir le schéma métier.',None),
('text.format.strict',None,None,'boolean','bool','TextFormat.strict','candidate','Tester les garanties de validation de sortie, pas seulement la sérialisation.',None),
]
for name,sch,field,ot,ct,sym,mp,note,vals in nested:
    o=oa(name,sch,field,ot,values=vals,chain=[ROOT,'CreateResponse → ResponseProperties / Reasoning',f'{sch or "TextResponseFormatConfiguration"}.{field or name}']) if sch else side(name,'openapi',symbol='TextResponseFormatConfiguration → '+name,type=ot,values=vals)
    c=cx(name,'common',sym,type=ct) if ct else None
    add('p-'+name.replace('.','-'),'parameter','Responses',name,o,c,mapping=mp,notes=note,confidence='HIGH' if c else 'UNKNOWN')
E[-11]['codex']['values']=['none','minimal','low','medium','high','xhigh','max','ultra','persistent','autres valeurs du catalogue']
E[-11]['additionalSources']=['catalog']
for name,typ,note,lot in [
('client_metadata','map<string,string>','Télémétrie/contexte client, pas un substitut au metadata public.',3),
('access_programs','AccessPrograms','Contexte d’accès explicite. Ne confère pas de droit ; aucune falsification ni contournement.',0),
('access_programs.cyber','standard | daybreak_blue | daybreak_red','Valeurs présentes dans le type ; utilisables seulement selon les droits du compte.',0),
('stream_options.reasoning_summary_delivery','sequential_cutoff','Option du sérialiseur Codex ; équivalence exacte au schéma public à vérifier.',3),
]:
    add('p-codex-'+name.replace('.','-'),'parameter','Responses',name,codex=cx(name,'common',name,type=typ),mapping='codex_only',lot=lot,notes=note,scope='CODEX_EXTENSION')
# WS continuation has a different contract from the HTTP struct.
for name,typ,note in [
('previous_response_id','Option<String>','Champ du WS Codex ; ne prouve pas le même comportement du POST HTTP ni la persistance cross-connexion.'),
('generate','Option<bool>','generate=false sert au préchauffage dans le contrat WS ; valider absence de génération et comportement de la réponse.'),
('type','response.create','Discriminant de ResponsesWsRequest, différent du JSON-RPC App Server.'),
('traceparent','Option<String>','Métadonnée de trace WS, pas l’identité du thread.'),
('tracestate','Option<String>','Conserver la trace autorisée ; ne pas l’utiliser comme état de conversation.'),
]:
    add('p-ws-'+name,'parameter','Responses WS',name,openai=side(name,'openapi',symbol='Schémas WebSocket Responses : résolution complète à importer',type=None),codex=cx(name,'common','ResponseCreateWsRequest.'+name if name in ['previous_response_id','generate'] else 'ResponsesWsRequest / ResponsesWsRequestMetadata.'+name,type=typ),mapping='candidate' if name in ['type','previous_response_id'] else 'codex_only',transport=('WS',),lot=4,notes=note,rc=3,ic=3)
# Endpoint registry: public equivalence is separately labelled from route existence.
def endpoint(id,fam,method,public,upstream,src,symbol,lot,mp='candidate',note='',transport=('HTTP',),req=None,resp=None,confidence='HIGH',where='BACKEND_NATIVE',ic=2):
    o=side(method+' /v1'+public,'openapi','#/paths/'+public.replace('~','~0').replace('/','~1')+'/'+method.lower(),symbol=req,chain=['servers[0].url + path',public,method,req] if req else ['servers[0].url + path',public,method]) if public else None
    c=cx(method+' '+upstream,src,symbol) if upstream and src else None
    x=add(id,'endpoint',fam,method+' '+(('/v1'+public) if public else upstream),o,c,mapping=mp,lot=lot,transport=transport,notes=note,confidence=confidence,where=where,ic=ic,rc=ic,endpoint=dict(method=method,publicPath=public,upstream=upstream,request=req,response=resp,auth='API key Platform ou auth Codex du provider selon la route ; jamais interchangeables sans vérification.',httpStatus='Codes, corps et headers upstream conservés. Le catalogue exhaustif des réponses OpenAPI est accessible par import.' if not resp else '200 '+resp+' ; erreurs upstream à préserver.'))
    return x
CP='/backend-api/codex'
endpoint('ep-responses','Responses','POST','/responses',CP+'/responses','common','ResponsesApiRequest',1,note='Chemin brut privilégié. Ne pas annoncer la compatibilité de tous les paramètres publics à partir de ce sous-ensemble.',transport=('HTTP','SSE'),req='CreateResponse',resp='Response / ResponseStreamEvent')
for meth,path,req,res in [('GET','/responses/{response_id}',None,'Response'),('DELETE','/responses/{response_id}',None,'ResponseDeleted'),('POST','/responses/{response_id}/cancel',None,'Response'),('GET','/responses/{response_id}/input_items',None,'ResponseItemList'),('POST','/responses/input_tokens',None,'objet response.input_tokens')]:
    endpoint('ep-'+meth.lower()+'-'+path.split('/')[-1].strip('{}'), 'Responses',meth,path,None,None,None,3,'unknown','Route publique à ne pas rediriger aveuglément. Aucun client Codex équivalent confirmé dans cet audit. Tester stockage, pagination, propriété et erreurs ; sinon erreur explicite unsupported.',req=req,resp=res,confidence='UNKNOWN',ic=3)
endpoint('ep-compact','Compaction','POST','/responses/compact',CP+'/responses/compact','compact','CompactClient::compact',3,'candidate','Compaction aussi publique. Préserver les items chiffrés ; tester compatibilité de replay. Différent de la compaction multi-agent implicite.',req='CompactResponseMethodPublicBody',resp='CompactResource',ic=3)
endpoint('ep-models','Models','GET','/models',CP+'/models?client_version=…','models','OpenAiModelsEndpoint::list_models',2,'translation','Le catalogue Codex est models:[ModelInfo] ; le format public est une liste d’objets Model. Ne pas inventer created ou owned_by manquants. Conserver un endpoint natif de métadonnées.',resp='liste publique / catalogue Codex')
endpoint('ep-model-one','Models','GET','/models/{model}',None,None,None,2,'unknown','Aucun client Codex dédié confirmé. Une recherche dans le catalogue serait une émulation, pas une route backend native.',confidence='UNKNOWN')
endpoint('ep-responses-ws','Responses WS','WS','/responses',CP+'/responses','common','ResponsesWsRequest / ResponseCreateWsRequest',4,'candidate','Conserver les cadres applicatifs. Reconnexion, replay et affinité compte/session exigent des tests ; pas de conversion SSE interne automatique.',transport=('WS',),req='response.create',resp='événements Responses',ic=3)
for op in ['generations','edits']:
    endpoint('ep-images-'+op,'Images','POST','/images/'+op,CP+'/images/'+op,'images','ImagesClient::'+('generate' if op=='generations' else 'edit'),5,'candidate','Le JSON est présent des deux côtés, y compris pour edits. Adapter uniquement les clients multipart et les champs sans équivalent. Le type ImageResponse perd certaines métadonnées : relayer la réponse brute.',req='CreateImageRequest' if op=='generations' else 'EditImageBodyJsonParam / CreateImageEditRequest',resp='ImagesResponse',ic=2)
for op in ['speech','transcriptions','translations']:
    endpoint('ep-audio-'+op,'Audio','POST','/audio/'+op,None,None,None,5,'unknown','Endpoint public audio indépendant. La voix Realtime et UserInput::Audio ne prouvent pas une route Codex OAuth équivalente.',confidence='UNKNOWN',ic=3)
endpoint('ep-rtc','Realtime','POST','/realtime/calls',CP+'/realtime/calls','rtc','RealtimeCallClient::create_with_session_and_headers',6,'translation','API : multipart sdp + session. Backend : JSON {sdp,session}. Pour v1 / Frameless backend : intent=quicksilver&architecture=avas. AVAS avec session refuse V2.',transport=('HTTP','WebRTC'),req='SDP + session',resp='SDP / Location',ic=4)
endpoint('ep-realtime-ws','Realtime','WS','/realtime','provider /realtime','rtws','RealtimeWebsocketClient::connect',6,'candidate','La voie directe inspectée requiert une clé API. Auth WebRTC distincte. Ne pas remplacer systématiquement la base par /backend-api/codex.',transport=('WS',),req='session.update / audio',resp='Realtime events',ic=4)
endpoint('ep-live','Live / Bidi','POST','/live',CP+'/realtime/calls','rtc','RealtimeCallClient::path_for_session',6,'translation','Le chemin API Frameless est live ; le backend reste realtime/calls. Les événements de délégation doivent être comparés par version.',transport=('HTTP','WebRTC','WS'),req='session Frameless + SDP',resp='SDP + Location',ic=5)
for route in ['/realtime/client_secrets','/realtime/sessions','/realtime/transcription_sessions','/realtime/calls/{call_id}/accept','/realtime/calls/{call_id}/reject','/realtime/calls/{call_id}/hangup','/realtime/calls/{call_id}/refer']:
    endpoint('ep-'+route.replace('/','-').replace('{','').replace('}',''),'Realtime','POST',route,None,None,None,6,'unknown','Route demandée dans le périmètre de recherche. Vérifier sa présence, version et éventuelle dépréciation dans le snapshot OpenAPI importé ; mapping Codex non établi.',confidence='UNKNOWN',ic=4)
endpoint('ep-memories','Memory','POST',None,CP+'/memories/trace_summarize','memories','MemoriesClient / MemorySummarizeInput',9,'codex_only','Synthèse de traces, pas une API complète de stockage de mémoire. Façade proposée : /v1/codex/memories/trace_summarize.',req='MemorySummarizeInput',resp='MemorySummarizeOutput',where='HYBRID',ic=4)
for meth,route,func in [('GET','/wham/tasks/list','list_tasks'),('GET','/wham/tasks/{task_id}','get_task_details_with_body'),('POST','/wham/tasks','create_task'),('GET','/wham/tasks/{task_id}/turns/{turn_id}/sibling_turns','list_sibling_turns'),('GET','/wham/accounts/check','get_accounts_check'),('GET','/wham/profiles/me','get_token_usage_profile'),('GET','/wham/config/bundle','get_config_bundle'),('GET','/wham/settings/user','get_user_settings'),('GET','/wham/workspace-messages','list_workspace_messages')]:
    endpoint('ep-control-'+func,'Control plane',meth,None,'/backend-api'+route,'backend','Client::'+func,10,'codex_only','PathStyle::ChatGptApi utilise /backend-api/wham ; PathStyle::CodexApi utilise /api/codex. Ne pas confondre avec la base d’inférence /backend-api/codex.',req='Voir fonction source',resp='Types backend du workspace',ic=4)
# Images typed fields and gaps, on both dedicated routes.
for op in ['generations','edits']:
    cstruct='ImageGenerationRequest' if op=='generations' else 'ImageEditRequest'
    osch='CreateImageRequest' if op=='generations' else 'EditImageBodyJsonParam'
    for name,ot,ct,required,note in [('prompt','string','String',True,'Texte demandé ; limites effectives modèle/route à tester.'),('model','string','String',True,'Le code Codex exige model ; ne pas hériter aveuglément du défaut public.'),('background','transparent | opaque | auto','Option<ImageBackground>',False,'Conserver omission et valeur auto.'),('n','integer','Option<_>',False,'Type entier exact à confirmer avant validation stricte ; nombre accepté dépend de la route.'),('quality','low | medium | high | auto','Option<ImageQuality>',False,'Les options publiques peuvent varier selon la famille de modèle.'),('size','string','Option<String>',False,'Ne pas figer une liste de résolutions dans le proxy.')]:
        add('p-image-'+op+'-'+name,'parameter','Images',op+'.'+name,oa(name,osch,name,type=ot),cx(name,'imagetypes',cstruct+'.'+name,type=ct,required=required),lot=5,notes=note)
    for name in ['output_format','output_compression','moderation','stream','partial_images','user']:
        add('p-image-'+op+'-'+name,'parameter','Images',op+'.'+name,side(name,'openapi',symbol=osch+' → '+name),mapping='unknown',lot=5,confidence='UNKNOWN',notes='À résoudre dans la variante publique exacte. Non présent dans le type Codex inspecté ; acceptation backend inconnue.',tests=['Importer le snapshot OpenAPI ; résoudre '+osch+'.'+name+' puis tester une valeur non par défaut sur le backend autorisé.'])
for name,typ in [('images','ImageUrl[]'),('images[].image_url','string')]:
    add('p-image-edit-'+name.replace('[]','').replace('.','-'),'parameter','Images','edits.'+name,side(name,'openapi',symbol='EditImageBodyJsonParam.'+name,type=typ),cx(name,'imagetypes','ImageEditRequest / ImageUrl.'+name,type=typ),lot=5,mapping='candidate',notes='La variante JSON publique peut éviter toute conversion multipart. Préserver la data URL ; vérifier les URL distantes avant d’implémenter un téléchargement hôte.')
for name,note in [('image','Multipart : convertir bytes → data URL dans images[].image_url uniquement sur ce profil.'),('mask','Le type ImageEditRequest inspecté ne porte pas mask. Pas de suppression silencieuse.'),('images[].file_id','Les identifiants hébergés ne sont pas prouvés compatibles avec Codex ; Files API hors périmètre.')]:
    add('p-image-extra-'+name.replace('[]','').replace('.','-'),'parameter','Images','edits.'+name,side(name,'openapi',symbol='CreateImageEditRequest / EditImageBodyJsonParam.'+name),mapping='translation' if name=='image' else 'unknown',lot=5,confidence='HIGH' if name=='image' else 'UNKNOWN',notes=note)
for name,typ in [('created','integer'),('data','array'),('data[].b64_json','string'),('background','string?'),('quality','string?'),('size','string?')]:
    add('p-image-output-'+name.replace('[]','').replace('.','-'),'parameter','Images','response.'+name,side(name,'openapi',symbol='ImagesResponse.'+name,type=typ),cx(name,'imagetypes','ImageResponse / ImageData.'+name,type=typ),lot=5,notes='Champ de réponse décodé par le client typé ; garder le corps brut complet en gateway.')
for name in ['usage','output_format']:
    add('p-image-output-'+name,'parameter','Images','response.'+name,side(name,'openapi',symbol='ImagesResponse.'+name),cx(name,'images','tests::response_body() → '+name),mapping='translation',lot=5,notes='Présent dans le mock backend officiel ; ignoré par ImageResponse. Preuve concrète qu’une reconstruction depuis le type appauvrit la réponse.',risk='high',tests=['Injecter la réponse officielle de test avec usage/output_format ; vérifier que la façade restitue ces objets sans perte.'])
# Model metadata complete selected ModelInfo section (not full nested catalog).
model_fields=[('slug','String'),('display_name','String'),('description','Option<String>'),('default_reasoning_level','Option<ReasoningEffort>'),('supported_reasoning_levels','Vec<ReasoningEffortPreset>'),('shell_type','ConfigShellToolType'),('visibility','ModelVisibility'),('supported_in_api','bool'),('priority','i32'),('additional_speed_tiers','Vec<String>'),('service_tiers','Vec<ModelServiceTier>'),('default_service_tier','Option<String>'),('available_access_programs','Option<ModelAccessPrograms>'),('availability_nux','Option<ModelAvailabilityNux>'),('upgrade','Option<ModelInfoUpgrade>'),('model_messages','Option<ModelMessages>'),('include_skills_usage_instructions','bool'),('include_plugin_usage_instructions','bool'),('include_apps_usage_instructions','bool'),('supports_reasoning_summary_parameter','bool'),('default_reasoning_summary','ReasoningSummary'),('support_verbosity','bool'),('default_verbosity','Option<Verbosity>'),('apply_patch_tool_type','Option<ApplyPatchToolType>'),('web_search_tool_type','WebSearchToolType'),('truncation_policy','TruncationPolicyConfig'),('supports_image_detail_original','bool'),('context_window','Option<i64>'),('max_context_window','Option<i64>'),('auto_compact_token_limit','Option<i64>'),('comp_hash','Option<String>'),('effective_context_window_percent','i64'),('experimental_supported_tools','Vec<String>'),('input_modalities','Vec<InputModality>'),('supports_search_tool','bool'),('supports_experimental_context','bool'),('use_responses_lite','bool'),('supports_reasoning_effort_updates','bool'),('node_repl_auto_review_required','bool'),('node_repl_disabled','bool'),('auto_review_model_override','Option<String>'),('model_specialty','Option<String>'),('tool_mode','Option<ToolMode>'),('multi_agent_version','Option<MultiAgentVersion>'),('multi_agent_reasoning_effort','Option<ReasoningEffort>'),('guardian','Option<GuardianModelPolicy>')]
for name,typ in model_fields:
    note='Champ de ModelInfo renvoyé par le catalogue Codex ; ne pas le perdre en exposant seulement la liste OpenAI.'
    if name=='slug': note='Candidat pour Model.id public ; vérifier collisions/alias. Ne pas fabriquer created/owned_by manquants.'
    if name=='input_modalities': note='text/image/audio. Le défaut client text+image si le champ est absent ne vaut pas preuve d’acceptation serveur.'
    if name=='comp_hash': note='Identifiant opaque de compatibilité des configurations de compaction ; conserver sans interprétation.'
    if name=='multi_agent_version': note='ModelInfo possède ce champ ; ModelPreset l’exclut explicitement de serde/TS/schema. Ne pas supposer toutes les surfaces équivalentes.'
    if name=='guardian': note='Politiques d’approbation issues du catalogue ; ne remplacent pas les exigences obligatoires de sécurité ou d’administration.'
    if name=='tool_mode': note='Direct / CodeMode / CodeModeOnly. Le flag ne fournit pas le runtime nécessaire.'
    add('p-model-'+name,'parameter','Models',name,oa('id','Model','id','string') if name=='slug' else None,cx(name,'catalog','ModelInfo.'+name,type=typ),mapping='translation' if name=='slug' else 'codex_only',lot=2,transport=('HTTP',),notes=note)
for name,typ,sym in [('supported_reasoning_levels[].effort','ReasoningEffort','ReasoningEffortPreset.effort'),('supported_reasoning_levels[].description','string','ReasoningEffortPreset.description'),('service_tiers[].id','string','ModelServiceTier.id'),('service_tiers[].name','string','ModelServiceTier.name'),('service_tiers[].description','string','ModelServiceTier.description'),('truncation_policy.mode','bytes | tokens','TruncationPolicyConfig.mode'),('truncation_policy.limit','i64','TruncationPolicyConfig.limit')]:
    add('p-model-nested-'+name.replace('[]','').replace('.','-'),'parameter','Models',name,codex=cx(name,'catalog',sym,type=typ),mapping='codex_only',lot=2,transport=('HTTP',),notes='Métadonnée native ; renvoyer dans la vue catalogue étendue sans la présenter comme un champ standard Model.')
# SSE event mapping: parser behavior separate from raw relay and backend availability.
sse_events=[
('response.created','Created{response_id}','partiel'),('response.in_progress',None,'ignoré'),('response.output_item.added','OutputItemAdded','typé'),('response.output_item.done','OutputItemDone','typé'),('response.output_text.delta','OutputTextDelta','partiel'),('response.output_text.done',None,'ignoré'),('response.content_part.added',None,'ignoré'),('response.content_part.done',None,'ignoré'),('response.function_call_arguments.delta',None,'ignoré'),('response.function_call_arguments.done',None,'ignoré'),('response.custom_tool_call_input.delta','ToolCallInputDelta','partiel'),('response.custom_tool_call_input.done',None,'ignoré'),('response.reasoning_summary_part.added','ReasoningSummaryPartAdded','partiel'),('response.reasoning_summary_part.done',None,'ignoré'),('response.reasoning_summary_text.delta','ReasoningSummaryDelta','partiel'),('response.reasoning_summary_text.done','ReasoningSummaryDone','partiel'),('response.reasoning_text.delta','ReasoningContentDelta','partiel'),('response.completed','Completed','partiel'),('response.failed','ApiError','converti en erreur'),('response.incomplete','ApiError::Stream','converti en erreur'),('response.metadata','traitement metadata hors parseur principal','spécifique'),('codex.rate_limits','RateLimits','spécifique')]
for ev,target,behavior in sse_events:
    public=not ev.startswith('codex.') and ev!='response.metadata'
    o=side(ev,'openapi',symbol='Schéma événement : discriminant type = '+ev) if public else None
    note='Comportement du parseur Codex : '+behavior+'. Pour une façade sans perte, conserver l’événement brut et l’ordre, y compris les champs que ce parseur ignore.'
    add('ev-'+ev,'event','Responses',ev,o,cx(ev,'sse','process_responses_event / '+(target or 'branche ignorée')),mapping='candidate' if public else 'codex_only',lot=1 if ev not in ['response.metadata','codex.rate_limits'] else 3,transport=('SSE','WS'),notes=note,risk='high' if behavior!='typé' else 'medium',parserBehavior=behavior,tests=['Rejouer un SSE fragmenté incluant '+ev+' ; comparer les événements bruts, la terminalité, les identifiants et les champs inconnus.'])
# Public event variants requiring actual verification remain UNKNOWN, not false absence.
for ev in ['response.queued','response.output_text.annotation.added','response.refusal.delta','response.refusal.done','response.web_search_call.in_progress','response.web_search_call.searching','response.web_search_call.completed','response.image_generation_call.in_progress','response.image_generation_call.partial_image','response.image_generation_call.completed','image_generation.partial_image','image_generation.completed','image_edit.partial_image','image_edit.completed','response.inject']:
    add('ev-'+ev,'event','Images' if ev.startswith('image_') else 'Multi-Agent' if ev=='response.inject' else 'Responses',ev,side(ev,'multi' if ev=='response.inject' else 'openapi',symbol='Événement '+ev),mapping='unknown',confidence='UNKNOWN',transport=('WS',) if ev=='response.inject' else ('SSE',),lot=9 if ev=='response.inject' else 5 if 'image' in ev else 3,notes='Événement à comparer au contrat backend réel et à la version exacte. Pas de suppression dans le relais brut, même si le client typé ne l’interprète pas.')
for name,typ in [('type','string'),('sequence_number','integer'),('item_id','string'),('call_id','string'),('output_index','integer'),('content_index','integer'),('summary_index','integer'),('delta','string'),('text','string'),('response','object'),('item','object')]:
    add('p-event-'+name,'parameter','Streaming','event.'+name,side(name,'openapi',symbol='Propriété conditionnelle selon le schéma d’événement',type=typ),cx(name,'sse','ResponsesStreamEvent / '+name,type=typ if name not in ['sequence_number','output_index'] else 'non stocké dans ResponsesStreamEvent inspecté'),mapping='candidate',lot=1,transport=('SSE','WS'),notes='Ce champ n’est PAS requis dans tous les événements. Les variantes et leurs required respectifs restent à résoudre. Ne pas fabriquer un schéma plat universel.')
# Realtime fields grounded in v2 serializer; no blanket OAuth assumption.
rtparams=[('instructions','string','session_update_session'),('output_modalities','text[] | audio[]','SessionUpdateSession.output_modalities'),('audio.input.format.type','audio/pcm','SessionAudioFormat.type'),('audio.input.format.rate','24000 dans cette voie','REALTIME_AUDIO_SAMPLE_RATE'),('audio.input.noise_reduction.type','near_field','NoiseReductionType::NearField'),('audio.input.transcription.model','gpt-4o-mini-transcribe dans cette voie','REALTIME_V2_INPUT_TRANSCRIPTION_MODEL'),('audio.input.turn_detection.type','server_vad','TurnDetectionType::ServerVad'),('audio.input.turn_detection.interrupt_response','true dans cette voie','SessionTurnDetection.interrupt_response'),('audio.input.turn_detection.create_response','true dans cette voie','SessionTurnDetection.create_response'),('audio.input.turn_detection.silence_duration_ms','500 dans cette voie','SessionTurnDetection.silence_duration_ms'),('audio.output.format.type','audio/pcm','SessionAudioOutputFormat.type'),('audio.output.format.rate','24000 dans cette voie','REALTIME_AUDIO_SAMPLE_RATE'),('audio.output.voice','RealtimeVoice','SessionAudioOutput.voice'),('tools','background_agent / silence','SessionFunctionTool'),('tool_choice','valeur du sérialiseur','REALTIME_V2_TOOL_CHOICE')]
for name,typ,sym in rtparams:
    add('p-rt-'+name.replace('.','-'),'parameter','Realtime',name,side(name,'openapi',symbol='Session Realtime V2 → '+name),cx(name,'rtv2',sym,type=typ),lot=6,transport=('WS',),mapping='candidate',ic=4,rc=3,notes='Valeurs du sérialiseur V2 inspecté, pas une liste exhaustive des options du service. Transcription-only et conversational ont des champs omis différents.')
for ev,sourceid,note in [('session.update','rtprotocol','V1/V2/Frameless ont des payloads différents.'),('input_audio_buffer.append','rtprotocol','Voie Realtime classique ; audio encodé.'),('conversation.item.create','rtprotocol','Message ou function_call_output ; ne pas confondre avec un tour App Server.'),('response.create','rtprotocol','Une requête Realtime, pas la structure Responses WS homonyme.'),('conversation.handoff.append','rtprotocol','Extension de handoff ; données de retour de l’agent.'),('input_audio.append','rtprotocol','Voie Frameless distincte de input_audio_buffer.append.'),('delegation.context.append','rtprotocol','Contexte d’une délégation ; identifiant et channel à conserver.'),('session.context.append','rtprotocol','Ajout de contexte session Frameless.'),('session.close','rtprotocol','Fermeture applicative, différente d’une coupure socket.'),('response.output_audio_transcript.delta','rtv2','Transcription de sortie ; ne pas perdre les delta texte.'),('conversation.item.input_audio_transcription.completed','rtv2','Transcription entrée complète ; distincte de /audio/transcriptions.')]:
    add('ev-rt-'+ev,'event','Realtime',ev,side(ev,'openapi',symbol='Realtime / Live : discriminant à résoudre selon version'),cx(ev,sourceid,'RealtimeOutboundMessage / parser → '+ev),mapping='candidate',lot=6,transport=('WS',),notes=note,ic=4,rc=4)
for name,typ in [('sdp','string'),('session','object'),('session.initial_items','message[]'),('session.delegation.type','client'),('intent','quicksilver'),('architecture','avas'),('Location','header URI'),('call_id','rtc_* ou UUID')]:
    add('p-rtc-'+name.replace('.','-'),'parameter','Live / Bidi',name,codex=cx(name,'rtc','BackendRealtimeCallRequest / RealtimeCallResponse / configure_realtime_call_request → '+name,type=typ),mapping='translation',lot=6,transport=('HTTP','WebRTC','WS'),notes='Distinguer API multipart, backend JSON et sideband. Le média WebRTC ne passe pas dans les événements SSE.',ic=4,rc=4)
# Header spelling, trust boundary, producer and purpose.
headers=[
('Authorization','provider','auth du provider','backend','Auth','Ne jamais transmettre le bearer entrant vers un hôte arbitraire. Injecter le credential du provider autorisé.','HIGH'),
('ChatGPT-Account-ID','backend','auth compte/workspace','backend ChatGPT','Auth / workspace','Ne pas laisser un appelant choisir un compte hors de ses droits.','HIGH'),
('originator','imagebackend','client officiel','backend','Contexte client','Ne pas fabriquer une identité d’un autre produit pour obtenir des capacités.','HIGH'),
('User-Agent','backend','client','backend','Identification client','Respecter la provenance réelle ; ne pas déduire qu’un UA donne des droits.','HIGH'),
('version','provider','client','backend','Version','Nom/version et émission par route à vérifier ; pas une garantie universelle.','UNKNOWN'),
('session-id','headers','build_session_headers','backend','Corrélation session','Orthographe sans préfixe x-.','HIGH'),
('thread-id','headers','build_session_headers','backend','Corrélation thread','Ne pas l’échanger avec l’identifiant de réponse.','HIGH'),
('x-session-id','headers','à identifier','à identifier','Inconnu','Mentionné dans le brief ; ce n’est pas le nom de build_session_headers. Aucun alias établi.','UNKNOWN'),
('x-client-request-id','headers','client','backend / logs','Corrélation requête','Conserver l’identifiant autorisé ; éviter les collisions.','HIGH'),
('x-openai-subagent','headers','runtime','backend','Type de sous-agent','Valeurs review/compact/memory_consolidation/collab_spawn dans le chemin inspecté ; ne lance pas à lui seul un agent.','HIGH'),
('x-codex-parent-thread','headers','à identifier','à identifier','Parent thread','Orthographe, émission et portée non vérifiées ; ne pas synthétiser par supposition.','UNKNOWN'),
('x-codex-turn-state','sse','backend','client puis backend','État / affinité','Opaque ; conservation de la valeur par tour et isolation par compte. Ni KV cache exporté, ni texte à décoder.','HIGH'),
('OpenAI-Model','sse','backend','client','Modèle effectif','Le parseur lit aussi x-openai-model ; garder le nom effectivement reçu.','HIGH'),
('X-Models-Etag','sse','backend','catalogue client','Fraîcheur catalogue','Signal d’invalidation ; ne pas confondre avec l’état de conversation.','HIGH'),
('X-Reasoning-Included','sse','backend','client','Métadonnée reasoning','Le code inspecté regarde sa présence ; ne pas inventer une valeur booléenne au moment du relais.','HIGH'),
('x-request-id','sse','backend','logs/client','Diagnostic','Conserver même sur erreur ; ne pas y mettre des secrets.','HIGH'),
('cf-ray','backend','proxy fournisseur','diagnostic','Trace réseau','Utilisation exacte à revalider ; ne confère aucun accès.','UNKNOWN'),
('x-oai-attestation','app','host officiel autorisé','backend','Attestation','Ne jamais fabriquer. Réutiliser uniquement un mécanisme officiel disponible ; sinon feature indisponible.','MEDIUM'),
('OpenAI-Beta','multi','client','API publique','Version beta','responses_multi_agent=v1 pour la beta documentée ; ne prouve pas un accès équivalent Codex.','HIGH'),
('x-codex-imagegen-request-id','images','backend image','client','Diagnostic image','Lu par ImagesClient indépendamment du x-request-id extérieur.','HIGH'),
('x-codex-image-turn-id','imagebackend','runtime image','backend','Corrélation image','Ajouté sur le chemin image dédié.','HIGH'),
('Location','rtc','backend WebRTC','client / sideband','ID d’appel','Garder call_id et réécrire l’URL publique seulement si nécessaire et sans perdre les identifiants.','HIGH')]
for name,src,producer,consumer,role,note,conf in headers:
    add('h-'+name.lower(),'header','Auth & headers',name,codex=cx(name,src,name),mapping='unknown' if conf=='UNKNOWN' else 'translation' if role.startswith('Auth') else 'codex_only',where='HYBRID',transport=('HTTP','SSE','WS'),lot=0 if role in ['Auth','Auth / workspace','Attestation','Identification client','Contexte client'] else 6 if name=='Location' else 3,confidence=conf,notes=note,transform='Politique de headers par route ; jamais de forwarding aveugle des secrets ou des headers hop-by-hop.',producer=producer,consumer=consumer,role=role,risk='high',tests=['Vérifier présence/absence, portée par route, isolation entre comptes et suppression sur redirection de '+name+'.'])
# Audio boundary: source-backed input type and public route mismatches.
for name,typ,sym,note in [('Audio.audio_url','string','UserInput::Audio','URI audio préencodée ; le code la transmet au chemin Responses.'),('LocalAudio.path','PathBuf','UserInput::LocalAudio','Préparation locale avant envoi. Le backend ne lit pas le chemin hôte.'),('Image.image_url','string','UserInput::Image','Data URL image dans ce chemin.'),('LocalImage.path','PathBuf','UserInput::LocalImage','Conversion locale en data URL ; isoler l’accès fichier.'),('Image.detail','Option<ImageDetail>','UserInput::Image','Original dépend des capacités du modèle, pas du seul schéma.')]:
    add('p-input-'+name.replace('.','-'),'parameter','Audio' if 'Audio' in name else 'Images',name,codex=cx(name,'input',sym,type=typ),mapping='candidate' if name.startswith(('Audio.','Image.')) else 'runtime',where='HYBRID',lot=5 if 'Audio' in name else 1,notes=note+' Vérification modèle nécessaire.',ic=2)
# Memory and control plane request fields that are actually in sources.
for name,typ,sym in [('model','String','MemorySummarizeInput.model'),('traces','RawMemory[]','MemorySummarizeInput.raw_memories [serde rename=traces]'),('traces[].id','String','RawMemory.id'),('traces[].metadata.source_path','String','RawMemoryMetadata.source_path'),('traces[].items','Value[]','RawMemory.items'),('reasoning','Option<Reasoning>','MemorySummarizeInput.reasoning'),('trace_summary','String','MemorySummarizeOutput.raw_memory [rename=trace_summary, alias=raw_memory]'),('memory_summary','String','MemorySummarizeOutput.memory_summary')]:
    add('p-mem-'+name.replace('[]','').replace('.','-'),'parameter','Memory',name,codex=cx(name,'common',sym,type=typ),mapping='codex_only',lot=9,notes='Contrat de synthèse de traces ; le stockage et le déclenchement des consolidations restent au runtime.',where='HYBRID',ic=4)
for name in ['limit','task_filter','environment_id','cursor']:
    add('p-control-'+name,'parameter','Control plane','tasks/list?'+name,codex=cx(name,'backend','Client::list_tasks_url → query '+name),mapping='codex_only',transport=('HTTP',),lot=10,notes='Paramètre de pagination/filtrage du control plane. Sans équivalent Responses direct.',ic=3)
# Runtime tools and capabilities. These are runtime contracts, not backend API endpoints.
tools=[
('function','FunctionTool / function_call','ResponseItem::FunctionCall','items','HYBRID',1,'L’appel est émis par le modèle ; le développeur exécute la fonction puis retourne function_call_output.'),
('custom','CustomTool / custom_tool_call','ResponseItem::CustomToolCall','items','HYBRID',3,'Conserver les entrées texte brutes et les deltas ; pas forcément des arguments JSON.'),
('web_search','outil public web_search','WebSearchToolCall','items','BACKEND_NATIVE',3,'Outil hébergé ; le niveau d’accès et les options dépendent du modèle/route.'),
('image_generation','outil public image_generation','ImageGenerationTool','imagetool','HYBRID',5,'Le chemin Codex inspecté passe par une extension locale qui appelle l’API Images ; ne pas supposer une seule implémentation hébergée.'),
('shell / PTY','outil shell / local_shell selon contrat','command/exec','app','RUNTIME_LOCAL',7,'Un appel shell n’exécute rien sans hôte, sandbox, gestion de session et retour d’outil.'),
('apply_patch','contrat apply_patch / custom selon version','outil de patch runtime','app','RUNTIME_LOCAL',7,'Conserver sémantique patch, chemins, résultat et approbation ; ne pas le réduire à du texte.'),
('filesystem workspace',None,'fs/readFile · fs/writeFile · fs/watch','app','RUNTIME_LOCAL',7,'Les fichiers génériques hébergés sont exclus ; les opérations workspace restent dans le périmètre.'),
('browser_use','computer/browser selon surface','navigateur / plugin hôte','browser','HYBRID',7,'Un flag ne crée pas un navigateur. Isoler origines, uploads/downloads et confirmations.'),
('computer_use','computer tool','computer use hôte','computer','HYBRID',7,'Accès à l’écran et aux entrées système soumis aux permissions ; pas un simple endpoint d’inférence.'),
('Code Mode','programmatic tool calling','ToolMode::CodeMode / CodeModeOnly','catalog','RUNTIME_LOCAL',7,'Le mode annoncé par le modèle demande un runtime d’exécution et des règles d’accès aux outils.'),
('MCP','outil MCP public','MCP client / server status','app','HYBRID',8,'L’outil MCP hébergé de l’API et les serveurs MCP gérés localement par Codex sont deux voies différentes.'),
('Apps / Connectors',None,'Apps / mentions / outils','app','HYBRID',8,'Préserver auth des applications, découverte, approbations et résultats, pas seulement le nom du connecteur.'),
('Plugins',None,'configuration et outils plugin','app','RUNTIME_LOCAL',8,'Un plugin peut assembler skills, MCP et runtime ; il ne se mappe pas à un seul tool schema.'),
('Skills',None,'UserInput::Skill','input','RUNTIME_LOCAL',8,'Nom et chemin SKILL.md sont interprétés par le runtime ; pas une modalité du modèle.'),
('Hooks',None,'feature hooks','features','RUNTIME_LOCAL',8,'Présence dans le registre ; ordre précis, erreurs et lifecycle à auditer avant parité.'),
('tool_search','tool search selon version','définition / chargement différé d’outils','features','HYBRID',8,'Différencier découverte d’outils, exécution et fallback ; le registre de flags ne prouve pas le contrat effectif.'),
('code_interpreter','outil public code_interpreter',None,None,'UNKNOWN',7,'Ne pas assimiler automatiquement l’environnement hébergé à Code Mode ou au shell local.'),
('spawn_agent local',None,'Handler::handle_spawn_agent → agent_control','spawn','RUNTIME_LOCAL',9,'Crée un thread agent côté runtime avec configuration et environnements ; distinct de la beta multi-agent hébergée.'),
('multi_agent hébergé','multi_agent.enabled','multi_agent_call / multi_agent_call_output','multi','BACKEND_NATIVE',9,'API beta officielle ; accès identique via le backend ChatGPT Codex non testé. Ne pas exécuter ces actions hébergées comme fonctions locales.'),
('review',None,'review/start','app','RUNTIME_LOCAL',9,'Parcours runtime dédié, avec événements et politiques ; pas un flag magique de /responses.'),
]
for name,pub,cname,src,loc,lot,note in tools:
    sid='t-'+name.lower().replace(' / ','-').replace(' ','-')
    conf='UNKNOWN' if loc=='UNKNOWN' else 'MEDIUM' if src in ['features','browser','computer'] else 'HIGH'
    add(sid,'tool','Tools' if lot<8 else 'Extensions' if lot==8 else 'Multi-Agent',name,side(pub,'openapi' if src!='multi' else 'multi',symbol=pub) if pub else None,cx(cname,src,cname) if src else None,mapping='unknown' if loc=='UNKNOWN' else 'runtime' if loc in ['RUNTIME_LOCAL','HYBRID'] else 'candidate',where=loc,transport=('HTTP','SSE','WS','JSON-RPC') if loc!='RUNTIME_LOCAL' else ('JSON-RPC',),lot=lot,confidence=conf,notes=note,ic=4 if loc!='BACKEND_NATIVE' else 3,rc=4 if conf!='HIGH' else 2,risk='high' if loc!='BACKEND_NATIVE' else 'medium',transform='Réutiliser le runtime officiel lorsque l’exécution est locale. Documenter séparément l’appel modèle et l’effet de l’outil.')
# Major capability coverage, all explicitly scoped with concrete acceptance experiments.
caps=[
('Text','Texte et code','BACKEND_NATIVE',1,'common','ResponsesApiRequest.input / TextControls','candidate','Conserver le format Responses ; ne pas passer par Chat Completions.', 'Flux texte + Unicode + arrêt client, même ordre et mêmes identifiants.'),
('Structured','Sorties JSON structurées','BACKEND_NATIVE',1,'common','TextFormat','candidate','Pass-through du JSON Schema sur le sous-ensemble supporté.', 'JSON valide, required, oneOf, refus modèle et schéma non supporté.'),
('Reasoning','Reasoning, résumés et état opaque','HYBRID',1,'common','Reasoning / include','superset','Conserver effort/context et encrypted_content ; aucun accès au raisonnement brut déchiffré.', 'Round-trip des items opaques et second tour sur le même compte.'),
('ImageInput','Compréhension d’images','HYBRID',1,'input','Image / LocalImage','candidate','Préparation locale seulement pour les chemins ; le reste natif.', 'Data URL et détail original avec un modèle autorisé.'),
('AudioInput','Audio dans Responses','HYBRID',5,'input','Audio / LocalAudio','candidate','Présence protocolaire établie, support modèle non mesuré.', 'Tester audio sur un modèle du catalogue annonçant audio, sans transcription silencieuse.'),
('ImageGen','Génération d’images','BACKEND_NATIVE',5,'images','ImagesClient::generate','candidate','Chemin dédié et retour brut pour garder usage/output_format.', 'Image décodable, métriques et erreurs conservées.'),
('ImageEdit','Édition et références image','HYBRID',5,'images','ImagesClient::edit','candidate','JSON commun possible ; conversion seulement pour une entrée multipart.', 'Même image, même prompt et options JSON ; vérifier références et refus.'),
('Voice','Voix bidirectionnelle','HYBRID',6,'rtcore','RealtimeSessionConfig','translation','Séparer WS direct/API-key et WebRTC/provider auth.', 'Audio aller/retour, interruptions, transcription et coût, par mode auth.'),
('Transcription','Dictée et transcription','HYBRID',6,'rtv2','RealtimeSessionMode::Transcription','translation','Voie Realtime établie ; /audio/transcriptions Codex non démontré.', 'Transcription seule sans génération audio, découpe des tours et flux final.'),
('ResponsesSSE','Responses HTTP / SSE','BACKEND_NATIVE',1,'sse','ResponsesStreamEvent','candidate','Relais des événements bruts, pas reconstruction depuis ResponseEvent.', 'Fragmentation multi-octets, trames inconnues, failed/incomplete et annulation.'),
('NonStream','Réponse JSON non streamée','HYBRID',1,'common','ResponsesApiRequest.stream','unknown','Acceptation stream=false par le backend non testée ; sinon agrégation du terminal et de ses items.', 'Réponse finale complète avec output, usage, erreurs et items inconnus.'),
('ResponsesWS','Responses WebSocket','HYBRID',4,'common','ResponseCreateWsRequest','candidate','Voie native, état et reconnexion explicites.', 'Deux tours, warmup, compte constant, reconnexion et fallback sans double exécution.'),
('RTC','WebRTC + sideband','HYBRID',6,'rtc','RealtimeCallClient','translation','Média, négociation SDP et contrôle sideband sont distincts.', 'Location, call_id, piste audio, coupure/reconnexion sideband sans seconde session.'),
('Bidi','Frameless Bidi / Live','HYBRID',6,'rtprotocol','RealtimeEventParser::FramelessBidi','translation','Router selon version ; delegation/session.context préservés.', 'Créer un appel V3, déléguer, ajouter du contexte, fermer proprement.'),
('Catalog','Modèles et capacités dynamiques','HYBRID',2,'catalog','ModelInfo','translation','Liste publique et catalogue natif distincts ; données par compte.', 'Changement ETag, alias sans collision, niveaux effort autorisés et isolation des comptes.'),
('Cache','Prompt cache et réutilisation','HYBRID',3,'common','prompt_cache_key','candidate','Clé stable + préfixe stable ; le KV reste au serveur. Aucun gain garanti par le proxy seul.', 'Comparer input_tokens_details.cached_tokens sur plusieurs requêtes de contrôle.'),
('State','Continuité session / tour','HYBRID',4,'sse','x-codex-turn-state','candidate','Garder opaque et isoler par compte ; session-id ≠ previous_response_id.', 'Reprendre après outil ; vérifier absence de mélange entre deux comptes et deux threads.'),
('Compact','Compaction distante','HYBRID',3,'compact','CompactClient','candidate','Renvoyer les items compacts natifs, pas un résumé maison.', 'Rejouer la sortie compact dans la conversation puis vérifier invariants.'),
('Memory','Mémoire et consolidation','HYBRID',9,'memories','MemoriesClient','codex_only','Service de synthèse + stockage/sélection runtime.', 'Synthèse de trace, persistance autorisée, rappel et suppression dans le bon contexte.'),
('Threads','Threads, historique, reprise','RUNTIME_LOCAL',7,'app','thread/start · thread/resume','runtime','Ne pas déguiser ces opérations en stockage public Responses.', 'Créer/reprendre/forker ; vérifier historique et isolation workspace.'),
('Turns','Tours, steering et interruption','RUNTIME_LOCAL',7,'app','turn/start · turn/steer · turn/interrupt','runtime','App Server conserve le lifecycle agentique.', 'Steer en cours, refus/annulation, un seul événement terminal cohérent.'),
('Shell','Shell, PTY et commandes','RUNTIME_LOCAL',7,'app','command/exec','runtime','Réutiliser le runtime officiel et sa sandbox.', 'Commande refusée, timeout, stdout/stderr, stdin, kill et fermeture PTY.'),
('Patch','Patchs et modifications','RUNTIME_LOCAL',7,'app','apply_patch','runtime','Validation de chemin et approbation conservées.', 'Patch applicable, conflit, refus et accès hors workspace bloqué.'),
('Workspace','Fichiers workspace','RUNTIME_LOCAL',7,'app','fs/*','runtime','Fichiers locaux uniquement ; Files API générique exclue.', 'Lecture/écriture/watch dans le workspace ; symlink et traversée de chemins refusés.'),
('Browser','Navigation / Browser Use','HYBRID',7,'browser','browser runtime','runtime','Navigateur et permissions nécessaires ; support produit à revalider.', 'Origines, upload/download, confirmations et données non fiables.'),
('Computer','Computer Use','HYBRID',7,'computer','computer runtime','runtime','Accès au poste contrôlé par l’hôte, pas une capacité du bearer seul.', 'Capture autorisée, action refusée et confirmation conservées.'),
('CodeMode','Code Mode / appels programmatiques','RUNTIME_LOCAL',7,'catalog','ToolMode','runtime','Registre de capacités + environnement d’exécution.', 'Outils accessibles seulement selon le contexte, erreurs et limites temps/mémoire.'),
('MCP','MCP','HYBRID',8,'app','MCP lifecycle','runtime','Transport, découverte, auth et approbations doivent survivre.', 'Outil distant, auth expirée, resource, annulation et erreur MCP.'),
('Apps','Apps / Connectors','HYBRID',8,'app','Apps / mentions','runtime','Accès externe délégué sous contrôle du compte.', 'Découverte et appel autorisé/refusé, sans fuite entre utilisateurs.'),
('Plugins','Plugins','RUNTIME_LOCAL',8,'app','Plugins','runtime','Distribution/config du runtime, pas une simple liste tools.', 'Activation/désactivation et héritage des permissions.'),
('Skills','Skills','RUNTIME_LOCAL',8,'input','UserInput::Skill','runtime','Chargement de contenu de skill par le runtime.', 'Sélection explicite, chemin exact et contenu effectivement injecté.'),
('Hooks','Hooks','RUNTIME_LOCAL',8,'features','hooks','runtime','Maturité et ordre précis encore à auditer.', 'Ordre avant/après outils, veto, timeout et erreur de hook.'),
('LocalAgents','Sous-agents Codex V1 / V2','RUNTIME_LOCAL',9,'spawn','agent_control.spawn_agent_with_metadata','runtime','Threads/fork/roles gérés localement ; contenus inter-agents potentiellement opaques.', 'Spawn/followup/wait/interrupt, fork et modèles distincts sans perte de contexte.'),
('HostedAgents','Multi-agent Responses hébergé','BACKEND_NATIVE',9,'multi','multi_agent.enabled','candidate','Beta API officielle distincte des sous-agents locaux ; accès backend Codex inconnu.', 'OpenAI-Beta, response.inject, actions hébergées non exécutées localement.'),
('Review','Review','RUNTIME_LOCAL',9,'app','review/start','runtime','Voie d’analyse dédiée conservant contraintes et lifecycle.', 'Review différentiel, interruption et retour du résultat au bon thread.'),
('Approvals','Approbations','RUNTIME_LOCAL',0,'app','approval request / response','runtime','Condition préalable à l’exécution locale ; jamais auto-approve pour faciliter le proxy.', 'Refus utilisateur et règle administrateur priment sur une demande du modèle.'),
('Sandbox','Sandbox / permissions','RUNTIME_LOCAL',0,'app','sandbox / permission profiles','runtime','Isolation multi-utilisateur obligatoire avant toute exposition réseau.', 'Chemins, réseau et commandes hors politique bloqués ; secrets non exposés.'),
('Control','Cloud et control plane','BACKEND_NATIVE',10,'backend','Client / PathStyle','codex_only','Services de tâches et comptes distincts du plan d’inférence.', 'Pagination, propriété des tâches, identité workspace et erreurs d’accès.'),
]
for key,name,loc,lot,src,sym,mp,note,test in caps:
    fam='Runtime' if loc=='RUNTIME_LOCAL' else 'Realtime' if key in ['Voice','Transcription','RTC','Bidi'] else 'Models' if key=='Catalog' else 'Images' if key in ['ImageGen','ImageEdit','ImageInput'] else 'Audio' if key=='AudioInput' else 'Control plane' if key=='Control' else 'Multi-Agent' if 'Agents' in key else 'Memory' if key=='Memory' else 'Responses'
    add('cap-'+key,'capability',fam,name,codex=cx(name,src,sym),mapping=mp,where=loc,transport=('JSON-RPC',) if loc=='RUNTIME_LOCAL' else ('WS','WebRTC') if fam=='Realtime' else ('HTTP','SSE','WS'),lot=lot,confidence='UNKNOWN' if mp=='unknown' else 'MEDIUM' if src in ['features','browser','computer'] else 'HIGH',notes=note,ic=5 if lot==6 else 4 if loc=='RUNTIME_LOCAL' else 3 if loc=='HYBRID' else 2,rc=4 if src in ['features','browser','computer'] else 2,tests=[test])
# Additional runtime/control entries: exact RPC names are sourced from the app-server doc.
for name,note,lot in [('thread/start','Nouveau contexte runtime.',7),('thread/resume','Reprise d’un thread persistant.',7),('thread/fork','Branche de conversation ; pas l’API publique Conversations.',7),('turn/start','Déclenchement d’un tour agentique.',7),('turn/steer','Ajout d’instructions pendant le tour.',7),('turn/interrupt','Interruption runtime ; pas POST responses/{id}/cancel.',7),('review/start','Tâche de review.',9),('fs/readFile','Lecture workspace.',7),('fs/writeFile','Écriture workspace.',7),('fs/watch','Abonnement au filesystem.',7),('command/exec','Exécution d’une commande sur l’hôte.',7)]:
    add('rpc-'+name.replace('/','-'),'endpoint','Runtime',name,codex=cx(name,'app',name),mapping='runtime',where='RUNTIME_LOCAL',transport=('JSON-RPC',),lot=lot,notes=note+' Vérifier schéma exact, stabilité et permissions dans le snapshot App Server utilisé.',ic=4,endpoint=dict(method='RPC',publicPath=None,upstream=name,request='Schéma App Server à générer pour le SHA retenu',response='Résultat RPC + notifications',httpStatus='Erreurs JSON-RPC ; pas des statuts HTTP d’inférence.'))
# Practical research experiments are reusable; no results claimed.
experiments=[
('X01','Figer un snapshot cohérent','Résoudre SHA git, télécharger OpenAPI JSON/YAML + fichiers Codex au même SHA, calculer SHA-256 des bytes. Comparer avec les fichiers réellement intégrés.','Bloquant pour la reproductibilité',0),
('X02','Mesurer la parité Responses','Sur un compte autorisé, jouer la même matrice en direct et via la façade ; comparer champs, erreurs, ordre des événements et terminalité.','Acceptation serveur non testée',1),
('X03','Distinguer nul / omission / défaut','Pour store, stream, tools, reasoning et instructions : tester absent, null, vide, valeur non par défaut. Documenter la sémantique, pas seulement le code HTTP.','Éviter les transformations silencieuses',1),
('X04','Valider le mode non-stream','Envoyer stream=false. Si non accepté, agréger à partir de la réponse terminale complète ; tester inconnus, erreurs et absence de terminal.','Compatibilité JSON',1),
('X05','Cache et état opaque','Mesurer les tokens en cache avec préfixe et clé stables ; rejouer reasoning/compaction chiffrés sans les décoder ; même compte et modèle compatible.','Pas de promesse de KV exportable',3),
('X06','WS et reconnexion','Warmup generate=false, deux réponses liées, outils et reconnexion. Prévenir la répétition des effets en cas de retry.','Affinité et double exécution',4),
('X07','Édition Images JSON','Comparer EditImageBodyJsonParam et ImageEditRequest ; tester URL/data URL, omission d’options, mask et format. Aucun ajout implicite de Files API.','Sous-ensemble JSON réellement commun',5),
('X08','Audio selon modèle','Récupérer input_modalities du catalogue du compte puis tester des entrées Audio/LocalAudio. Une transcription automatique doit être un profil explicite, jamais silencieux.','Capacité protocolaire ≠ modèle',5),
('X09','Realtime par voie auth','Séparer API-key WS direct, WebRTC avec provider auth et sideband. Tester v1/v2/v3, Location/call_id, session, interruptions et close.','Voies non interchangeables',6),
('X10','Agent loop et permissions','Laisser le runtime officiel gérer tool calls ; vérifier approval deny, sandbox, fichiers, symlinks, réseau, annulation et secrets.','Précondition à l’exposition multi-utilisateur',7),
('X11','Distinguer les deux multi-agents','Vérifier V1/V2 local versus beta Responses hébergée. Pour l’hébergé, ne pas exécuter multi_agent_call ; tester response.inject séparément.','Éviter une fausse équivalence',9),
('X12','Control plane autorisé','Vérifier les routes /wham, pagination et propriété workspace. Ne pas transférer des credentials vers une destination de redirection.','Séparation inference / control',10),
('X13','Auditer les traducteurs communautaires','Suivre le vrai ClientAdapter CLIProxyAPI et ses tests ; produire un diff exact des champs supprimés/renommés. Le petit fichier codex_executor.go ne suffit pas.','Source communautaire non canonique',3),
('X14','Résoudre le schéma intégral','Importer le JSON OpenAPI complet avec extraction des branches ; vérifier le nombre de routes et de paramètres, refs manquantes/cycles, et mettre les champs non revus en UNKNOWN.','Inventaire complet non embarqué',0),
]
X=[dict(id=i,title=t,procedure=p,reason=r,lot=l,status='NOT_RUN') for i,t,p,r,l in experiments]
# Lots are recommendations, not claims of existing compatibility.
lot_names=['Socle de preuve & sécurité','Responses Core','Models & capacités','Responses avancées','Responses WebSocket','Images & audio','Realtime & Live','Runtime & outils','MCP, Apps & extensions','Agents, review & mémoire','Control plane Codex']
lot_details=[
('Fixer les sources, les identités et les frontières de confiance.',[], 'X01 X10 X14',3,3),
('Une façade utile pour texte, reasoning, JSON Schema, images d’entrée et appels outils. Le client reste responsable des fonctions.',[0,2], 'X02 X03 X04',2,2),
('Découverte dynamique ; lot à mener en parallèle et en préalable opérationnel au Core.',[0], 'X01 X02',2,2),
('Compaction, état, cache, outils avancés. Storage et input_tokens restent des gates séparés.',[1,2], 'X03 X05 X13',3,3),
('Continuation native et moindre overhead, sans dégrader le flux ni répéter les effets.',[1,2,3], 'X06',3,3),
('Routes Images JSON dédiées et entrées audio. TTS/transcription autonomes restent inconnus tant que non prouvés.',[1,2], 'X07 X08',3,3),
('Voix et conversations Realtime ; négociation, média, sideband et versions clairement séparés.',[0,2,4], 'X09',5,5),
('Réutiliser Codex pour shell, patch, fichiers locaux et permissions ; ne pas réécrire l’agent loop.',[0,1], 'X10',4,4),
('Préserver configuration, accès, découverte et confirmations des extensions.',[7], 'X10',4,4),
('Agents locaux / hébergés distincts, review, mémoire et compaction automatisée.',[3,4,7], 'X05 X11',5,5),
('Tâches cloud et services de workspace ; faible priorité pour le premier gateway.',[0,7], 'X12',4,5),
]
L=[]
for i,(desc,deps,tests,rc,ic) in enumerate(lot_details):
    L.append(dict(id=i,title=lot_names[i],value=desc,dependencies=deps,experiments=tests.split(),researchComplexity=rc,implementationComplexity=ic,risk='high' if ic>3 else 'medium',architecture='Wire brut quand possible ; runtime officiel seulement pour les actions locales.',researchRemaining='Exécuter les expériences attachées avant de transformer ces candidats en compatibilité annoncée.',entryIds=[e['id'] for e in E if e['lot']==i]))
D=dict(meta=dict(title='Codex Contract Atlas',date=DATE,version='0.1-source-audit',objective='OpenAI-compatible, traduction minimale, capacités Codex accessibles préservées.',exhaustive=False,liveVerified=False,snapshotMode='Sources main non figées ; aucun SHA unique garanti.',sourceByteHashesAvailable=False,scope=['Responses','Models','Images','Audio','Realtime','Live','Tools','Runtime','Extensions','Multi-Agent','Memory','Control plane'],excluded=['Vidéo','Files API générique','Uploads API générique'],coverageNote='Inventaire éditorial sourcé des surfaces majeures ; pas une extraction exhaustive de toutes les branches OpenAPI. Les limites, sources non revues et expériences sont explicites.',rootFieldsReviewed=len(fields),upstreamTotalFields=None,limitations=['Aucun appel authentifié effectué.','Pas de snapshot unifié figé au SHA ; les pages main peuvent représenter des révisions différentes.','OpenAPI JSON intégral non copié dans cet environnement (limite du lecteur web). Sections YAML consultées ; projection et outil d’import fournis.','Types et schémas imbriqués non tous résolus dans le jeu éditorial ; l’import/extracteur complète un inventaire structurel, pas sa validation backend.','Authentification, quotas et disponibilité réelle restent dépendants du compte, du modèle et de la surface.','Les expériences décrites sont à exécuter ; aucune ne porte un résultat inventé.']),sources=list(S.values()),entries=E,experiments=X,lots=L)
for e in E:
    if e.get('endpoint') and e['endpoint']['method'] != 'RPC':
        e['endpoint']['httpStatus'] = ('Handshake et codes de clôture à vérifier ; conserver les erreurs de transport.' if e['endpoint']['method'] == 'WS' else 'Statuts exacts à résoudre dans OpenAPI et vérifier sur le backend ; aucune capture authentifiée.')
        e['endpoint']['auth'] = 'API publique : credential Platform autorisé. Backend Codex : credential fournisseur accepté par cette route, à vérifier séparément.'
assert len(E)==len({x['id'] for x in E}), 'duplicate entry ids'
for e in E:
    for sidekey in ['openai','codex']:
        sd=e.get(sidekey)
        if sd: assert sd['sourceId'] in S,(e['id'],sd)
    assert e['notes'] and e['tests']
(BASE/'data'/'mapping.json').write_text(json.dumps(D,ensure_ascii=False,indent=2))
(BASE/'data'/'sources.json').write_text(json.dumps(D['sources'],ensure_ascii=False,indent=2))
with (BASE/'data'/'mapping.csv').open('w',newline='') as f:
    w=csv.writer(f); w.writerow(['id','category','family','name','openai','codex','mapping','location','transport','confidence','lot','research_complexity','implementation_complexity','live_verified','notes'])
    for e in E: w.writerow([e['id'],e['category'],e['family'],e['name'],(e.get('openai') or {}).get('name',''),(e.get('codex') or {}).get('name',''),e['mapping'],e['executionLocation'],';'.join(e['transport']),e['confidence'],e['lot'],e['researchComplexity'],e['implementationComplexity'],'false',' '.join(e['notes'])])
print(len(E),'records',len(S),'sources',len([x for x in E if x['category']=='capability']),'capabilities')
from collections import Counter
print(Counter(x['category'] for x in E))
