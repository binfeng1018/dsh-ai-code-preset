import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const code=await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
test('mount effects only access declared Cordis services',()=>{
 const effects=[];let module,Panel;
 const React={createElement:(type,props,...children)=>({type,props,children}),Fragment:'fragment',useState:v=>[v,()=>{}],useEffect:fn=>effects.push(fn),useRef:v=>({current:v})};
 const win={__ModuleLoader__:{load:m=>module=m},addEventListener(){},removeEventListener(){}};
 vm.runInNewContext(code,{window:win,console});const plugin=module.factory(()=>React);
 const list={subscribe:()=>()=>{},getSnapshot:()=>({items:[],byId:{}})};
 const values={effect:fn=>fn(),desktopWorkbenches:{register:(d,p)=>{Panel=p;}},uiWorkspace:{},sessions:{list},workspaces:{list}};
 const ctx=new Proxy(values,{get(target,key){if(key!=='effect'&&!plugin.inject.includes(key))throw Error('cannot get property '+key+' without inject');return target[key];}});
 plugin.apply(ctx);Panel({service:{subscribe:()=>()=>{},currentSession:()=>undefined,state:{}},entry:{id:'test'},active:true});
 for(const effect of effects){const cleanup=effect();cleanup?.();}
 assert.ok(plugin.inject.includes('sessions'));assert.ok(plugin.inject.includes('workspaces'));
});
test('client registers correct module and renders usable no-project state without creating sessions',()=>{
 let module,registered,sessionCalls=0,pickerCalls=0;
 const React={createElement:(type,props,...children)=>({type,props,children}),Fragment:'fragment',useState:v=>[v,()=>{}],useEffect:()=>{},useRef:v=>({current:v})};
 vm.runInNewContext(code,{window:{__ModuleLoader__:{load:v=>module=v}},console});
 assert.equal(module.id,'dsh-ai-coding-workbench-local');
 const plugin=module.factory(name=>{assert.equal(name,'react');return React;});
 const ctx={effect:fn=>fn(),uiWorkspace:{pickDirectory:()=>{pickerCalls++;}},desktopWorkbenches:{register:(d,Panel)=>{registered={d,Panel};return()=>{};},ensureSession:()=>sessionCalls++}};
 plugin.apply(ctx);assert.equal(registered.d.customFrame,true);assert.equal(registered.d.title,'AI 编程工作台');assert.equal(registered.d.repository,'https://github.com/binfeng1018/dsh-ai-code-preset.git');
 const ui=registered.Panel({service:{},entry:{id:'test'},active:true,conversation:'native conversation'});
 assert.equal(ui.props.className,'acw');assert.match(JSON.stringify(ui),/选择项目文件夹/);assert.equal(sessionCalls,0);assert.equal(pickerCalls,0);
});
test('all workbench CSS selectors exclude host-native conversation',()=>{
 let module,Panel;const React={createElement:(type,props,...children)=>({type,props,children}),Fragment:'fragment',useState:v=>[v,()=>{}],useEffect:()=>{},useRef:v=>({current:v})};
 vm.runInNewContext(code,{window:{__ModuleLoader__:{load:m=>module=m}},console});module.factory(()=>React).apply({effect:fn=>fn(),desktopWorkbenches:{register:(d,p)=>Panel=p}});
 const ui=Panel({service:{},entry:{id:'test'},active:true});const css=ui.children[0].children[0];
 const rules=[...css.matchAll(/([^{}]+)\{/g)].map(m=>m[1].trim()).filter(s=>!s.startsWith('@'));
 assert.ok(rules.length>30);
 for(const selector of rules){assert.ok(selector.includes(':not(.acw .native, .acw .native *)'),selector);}
});
test('both sidebar separators support drag, keyboard, bounds and reset',()=>{
 let module,Panel;const updates=[];let index=0;
 const React={createElement:(type,props,...children)=>({type,props,children}),Fragment:'fragment',useState:v=>{const i=index++;return[v,n=>updates.push({i,n})];},useEffect:()=>{},useRef:v=>({current:v})};
 vm.runInNewContext(code,{window:{__ModuleLoader__:{load:m=>module=m}},console});module.factory(()=>React).apply({effect:fn=>fn(),desktopWorkbenches:{register:(d,p)=>Panel=p}});
 const ui=Panel({service:{},entry:{id:'test'},active:true});const nodes=[];function walk(n){if(!n||typeof n!=='object')return;nodes.push(n);for(const c of (n.children||[]).flat(Infinity))walk(c);}walk(ui);
 const separators=nodes.filter(n=>n.props?.role==='separator');assert.equal(separators.length,2);
 ui.props.ref.current={clientWidth:1200};nodes.find(n=>n.props?.className==='business').props.ref.current={clientWidth:760,querySelector:()=>({getBoundingClientRect:()=>({width:210})})};nodes.find(n=>n.props?.className==='chat').props.ref.current={getBoundingClientRect:()=>({width:430})};
 const event={button:0,clientX:200,pointerId:1,preventDefault(){},currentTarget:{setPointerCapture(){}}};
 separators[0].props.onPointerDown(event);separators[0].props.onPointerMove({clientX:260});assert.ok(updates.some(v=>v.n===270));separators[0].props.onPointerMove({clientX:-999});assert.ok(updates.some(v=>v.n===100));separators[0].props.onPointerUp();
 separators[1].props.onPointerDown(event);separators[1].props.onPointerMove({clientX:150});assert.ok(updates.some(v=>v.n===480));separators[1].props.onPointerCancel();
 separators[1].props.onKeyDown({key:'ArrowLeft',preventDefault(){}});assert.ok(updates.some(v=>v.n===440));separators[1].props.onDoubleClick();assert.equal(updates.at(-1).n,null);
});
test('built client contains no separate chat implementation or automatic command execution',()=>{
 assert.ok(code.includes('ensureSession({folder:project.root})'));
 assert.ok(code.includes("h('div',{className:'native'},conversation)"));
 assert.ok(!code.includes('child_process'));
 assert.ok(code.includes("method:'POST',credentials:'same-origin'"));
});
