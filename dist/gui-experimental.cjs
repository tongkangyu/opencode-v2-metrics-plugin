"use strict";Object.defineProperties(exports,{__esModule:{value:!0},[Symbol.toStringTag]:{value:"Module"}});const n=require("solid-js/web"),v=require("solid-js"),d=require("@opencode/plugin/gui"),M=require("@opencode/plugin/rpc"),_={type:"object",properties:{providerID:{type:"string"},modelID:{type:"string"},variant:{type:"string"}},required:["providerID","modelID"],additionalProperties:!1},y={type:"object",properties:{sessionID:{type:"string"},assistantMessageID:{type:"string"},status:{type:"string",enum:["streaming","completed","error"]},model:_,startedAt:{type:"number"},firstTextAt:{type:"number"},completedAt:{type:"number"},firstTokenMs:{type:"number"},outputTokens:{type:"number"},inputTokens:{type:"number"},reasoningTokens:{type:"number"},cacheReadTokens:{type:"number"},cacheWriteTokens:{type:"number"},cacheHitRate:{type:"number"},outputTokensPerSecond:{type:"number"},finish:{type:"string"},error:{type:"string"}},required:["sessionID","assistantMessageID","status","model","startedAt"],additionalProperties:!1},h=M.Rpc.define({id:"opencode-v2-metrics",methods:{get:{input:{type:"object",properties:{sessionID:{type:"string"}},required:["sessionID"],additionalProperties:!1},output:{type:"object",properties:{metrics:{anyOf:[y,{type:"null"}]}},required:["metrics"],additionalProperties:!1}}},events:{updated:{schema:{type:"object",properties:{metrics:y},required:["metrics"],additionalProperties:!1}}}});var C=n.template("<div class=opencode-v2-metrics-bar><span class=opencode-v2-metrics-item><span class=opencode-v2-metrics-label>速度</span><span class=opencode-v2-metrics-value></span></span><span class=opencode-v2-metrics-item><span class=opencode-v2-metrics-label>首字</span><span class=opencode-v2-metrics-value></span></span><span class=opencode-v2-metrics-item><span class=opencode-v2-metrics-label>缓存</span><span class=opencode-v2-metrics-value></span></span><span class=opencode-v2-metrics-model>");const T=e=>e===void 0||!Number.isFinite(e)?"—":e<1e3?`${Math.round(e)} ms`:`${(e/1e3).toFixed(2)} s`,q=e=>e===void 0||!Number.isFinite(e)?"—":`${e.toFixed(e>=100?0:1)} tok/s`,j=e=>e===void 0||!Number.isFinite(e)?"—":`${(e*100).toFixed(1)}%`,x=e=>{const l=`${e.model.providerID}/${e.model.modelID}`;return e.model.variant?`${l}#${e.model.variant}`:l},k=d.Plugin.define({setup(e){const[l,u]=v.createSignal({});e.add(d.Style,`
        .opencode-v2-metrics-bar {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 14px;
          min-height: 26px;
          padding: 3px 12px;
          border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
          color: color-mix(in srgb, currentColor 72%, transparent);
          font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: nowrap;
          overflow: hidden;
        }

        .opencode-v2-metrics-bar[data-status="streaming"] {
          color: color-mix(in srgb, currentColor 88%, transparent);
        }

        .opencode-v2-metrics-item {
          display: inline-flex;
          align-items: baseline;
          gap: 5px;
        }

        .opencode-v2-metrics-label {
          opacity: 0.65;
        }

        .opencode-v2-metrics-value {
          color: currentColor;
          font-weight: 600;
        }

        .opencode-v2-metrics-model {
          max-width: 260px;
          overflow: hidden;
          text-overflow: ellipsis;
          opacity: 0.55;
        }

        @media (max-width: 720px) {
          .opencode-v2-metrics-bar { gap: 8px; font-size: 10px; }
          .opencode-v2-metrics-model { display: none; }
        }
      `),d.createKeyed(()=>e.servers.get("sidecar")?.client,o=>{if(!o)return;const a=o.rpc(h),t=a.events.on("updated",r=>{const i=r.data.metrics;u(c=>({...c,[i.sessionID]:i}))});v.onCleanup(t);const s=e.sessions.current();s&&a.get({sessionID:s.id}).then(r=>{const i=r;if(!i.metrics)return;const c=i.metrics;u(m=>({...m,[c.sessionID]:c}))})}),d.createKeyed(()=>e.sessions.current()?.id,o=>{if(!o)return;const a=e.servers.get("sidecar")?.client;a&&a.rpc(h).get({sessionID:o}).then(t=>{const s=t;if(!s.metrics)return;const r=s.metrics;u(i=>({...i,[r.sessionID]:r}))})}),e.add(d.Slot,{at:"window.bottom",order:90,render:()=>{const o=e.sessions.current(),a=o?l()[o.id]:void 0;return n.createComponent(v.Show,{when:a,children:t=>(()=>{var s=C(),r=s.firstChild,i=r.firstChild,c=i.nextSibling,m=r.nextSibling,$=m.firstChild,D=$.nextSibling,b=m.nextSibling,S=b.firstChild,I=S.nextSibling,w=b.nextSibling;return n.insert(c,()=>q(t().outputTokensPerSecond)),n.insert(D,()=>T(t().firstTokenMs)),n.insert(I,()=>j(t().cacheHitRate)),n.insert(w,()=>x(t())),n.effect(p=>{var g=t().status,f=x(t());return g!==p.e&&n.setAttribute(s,"data-status",p.e=g),f!==p.t&&n.setAttribute(s,"title",p.t=f),p},{e:void 0,t:void 0}),s})()})}})}});exports.default=k;
