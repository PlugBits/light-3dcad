const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/sdk-CJodkDwg.js","assets/rolldown-runtime-hePW80VL.js","assets/index-BBxzI3Vw.js","assets/index-D110zMzA.css"])))=>i.map(i=>d[i]);
import{r as e}from"./rolldown-runtime-hePW80VL.js";import{_ as t,g as n,h as r,i,o as a}from"./index-BBxzI3Vw.js";var o=e(t(),1),s=class{errors=[];push(e,t){this.errors.push(`${e}: ${t}`)}get hasErrors(){return this.errors.length>0}};function c(e){return typeof e==`object`&&!!e&&!Array.isArray(e)}function l(e){return typeof e==`number`&&Number.isFinite(e)}function u(e){return l(e)&&e>0}function d(e){return typeof e==`string`&&e.length>0}function f(e,t,n){return u(e)?e:(n.push(t,`正の数である必要があります`),null)}function p(e,t,n){return l(e)?e:(n.push(t,`有限の数である必要があります`),null)}function m(e,t,n){return!Number.isInteger(e)||e<3||e>24?(n.push(t,`3〜24の整数である必要があります`),null):e}function h(e,t,n){return!Array.isArray(e)||e.length!==2||!l(e[0])||!l(e[1])?(n.push(t,`[x, y]形式の座標(有限数2要素)である必要があります`),null):[e[0],e[1]]}function g(e,t,n){if(!c(e))return n.push(t,`点参照はオブジェクトである必要があります`),null;let r=e.segment,i=e.point;return d(r)?i!==`start`&&i!==`end`?(n.push(`${t}.point`,`"start"または"end"である必要があります`),null):{segmentId:r,point:i}:(n.push(`${t}.segment`,`スケッチ要素IDは空でない文字列である必要があります`),null)}function _(e,t,n,r){let i=`${n.path}.entities[${t}]`;if(!c(e))return r.push(i,`オブジェクトである必要があります`),null;let a=e.kind,o=e.id;if(!d(o))return r.push(`${i}.id`,`空でない文字列である必要があります`),null;if(n.entityIds.has(o))return r.push(i,`図形ID "${o}" がスケッチ内で重複しています`),null;switch(n.entityIds.add(o),a){case`rectangle`:{let t=h(e.center,`${i}.center`,r),n=f(e.width,`${i}.width`,r),a=f(e.height,`${i}.height`,r);return!t||n===null||a===null?null:{kind:`rectangle`,id:o,center:t,width:n,height:a}}case`circle`:{let t=h(e.center,`${i}.center`,r),n=f(e.radius,`${i}.radius`,r);return!t||n===null?null:{kind:`circle`,id:o,center:t,radius:n}}case`polygon`:{let t=e.points;if(!Array.isArray(t)||t.length<3)return r.push(`${i}.points`,`3点以上の頂点配列である必要があります`),null;let n=[],a=!0;return t.forEach((e,t)=>{let o=h(e,`${i}.points[${t}]`,r);o?n.push(o):a=!1}),a?{kind:`polygon`,id:o,points:n}:null}case`slot`:{let t=h(e.start,`${i}.start`,r),n=h(e.end,`${i}.end`,r),a=f(e.width,`${i}.width`,r);return!t||!n||a===null?null:{kind:`slot`,id:o,start:t,end:n,width:a}}case`regularPolygon`:{let t=h(e.center,`${i}.center`,r),n=f(e.radius,`${i}.radius`,r),a=m(e.sides,`${i}.sides`,r),s=e.rotation,c;if(s!=null){let e=p(s,`${i}.rotation`,r);if(e===null)return null;c=e}return!t||n===null||a===null?null:{kind:`regularPolygon`,id:o,center:t,radius:n,sides:a,...c===void 0?{}:{rotation:c}}}default:return r.push(`${i}.kind`,`未対応の図形種別です: ${JSON.stringify(a)}(rectangle/circle/polygon/slot/regularPolygonのいずれか)`),null}}function v(e,t,n,r){let i=`${n.path}.segments[${t}]`;if(!c(e))return r.push(i,`オブジェクトである必要があります`),null;let a=e.kind,o=e.id;if(!d(o))return r.push(`${i}.id`,`空でない文字列である必要があります`),null;if(n.segmentIds.has(o))return r.push(i,`スケッチ要素ID "${o}" がスケッチ内で重複しています`),null;if(a!==`line`&&a!==`arc`)return r.push(`${i}.kind`,`未対応の線分/円弧種別です: ${JSON.stringify(a)}("line"または"arc")`),null;let s=h(e.p1,`${i}.p1`,r),u=h(e.p2,`${i}.p2`,r);if(!s||!u)return null;let f=s[0]-u[0],p=s[1]-u[1];if(Math.sqrt(f*f+p*p)<=1e-6)return r.push(i,`始点と終点が一致しています(同一点)`),null;if(n.segmentIds.add(o),n.segmentKindById.set(o,a),a===`line`)return{kind:`line`,id:o,p1:s,p2:u};let m=e.bulge;return l(m)?{kind:`arc`,id:o,p1:s,p2:u,bulge:m}:(r.push(`${i}.bulge`,`有限数である必要があります`),null)}function y(e,t,n,r){return n.segmentIds.has(e.segmentId)?{segmentId:e.segmentId,end:e.point===`start`?`p1`:`p2`}:(r.push(t,`"${e.segmentId}" というIDのスケッチ要素が見つかりません`),null)}function b(e,t,n,i){let a=`${n.path}.constraints[${t}]`;if(!c(e))return i.push(a,`オブジェクトである必要があります`),null;let o=e.kind,s=r(`constraint`);switch(o){case`distance`:{let t=g(e.a,`${a}.a`,i),r=g(e.b,`${a}.b`,i),o=e.value;if((!l(o)||o<0)&&i.push(`${a}.value`,`0以上の有限数である必要があります`),!t||!r||!l(o)||o<0)return null;let c=y(t,`${a}.a`,n,i),u=y(r,`${a}.b`,n,i);return!c||!u?null:{id:s,kind:`distance`,a:c,b:u,value:o}}case`radius`:{let t=e.segment,r=e.value;return d(t)||i.push(`${a}.segment`,`空でない文字列である必要があります`),u(r)||i.push(`${a}.value`,`正の数である必要があります`),!d(t)||!u(r)?null:n.segmentIds.has(t)?n.segmentKindById.get(t)===`arc`?{id:s,kind:`radius`,segmentId:t,value:r}:(i.push(a,`半径拘束は円弧にのみ指定できます("${t}"はarcではありません)`),null):(i.push(a,`"${t}" というIDのスケッチ要素が見つかりません`),null)}case`horizontal`:case`vertical`:{let t=e.segment;return d(t)?n.segmentIds.has(t)?{id:s,kind:o,segmentId:t}:(i.push(a,`"${t}" というIDのスケッチ要素が見つかりません`),null):(i.push(`${a}.segment`,`空でない文字列である必要があります`),null)}case`coincident`:{let t=g(e.a,`${a}.a`,i),r=g(e.b,`${a}.b`,i);if(!t||!r)return null;let o=y(t,`${a}.a`,n,i),c=y(r,`${a}.b`,n,i);return!o||!c?null:{id:s,kind:`coincident`,a:o,b:c}}default:return i.push(`${a}.kind`,`未対応の拘束種別です: ${JSON.stringify(o)}(distance/radius/horizontal/vertical/coincidentのいずれか)`),null}}function x(e,t,n){let i=`sketches[${t}]`;if(!c(e))return n.push(i,`オブジェクトである必要があります`),null;let a=e.id;if(!d(a))return n.push(`${i}.id`,`空でない文字列である必要があります`),null;let o=e.plane;if(o!==`XY`&&o!==`XZ`&&o!==`YZ`)return n.push(`${i}.plane`,`"XY"/"XZ"/"YZ"のいずれかである必要があります`),null;let s=e.entities,l=e.segments,u=e.constraints;if(s!==void 0&&!Array.isArray(s))return n.push(`${i}.entities`,`配列である必要があります`),null;if(l!==void 0&&!Array.isArray(l))return n.push(`${i}.segments`,`配列である必要があります`),null;if(u!==void 0&&!Array.isArray(u))return n.push(`${i}.constraints`,`配列である必要があります`),null;let f={path:i,entityIds:new Set,segmentIds:new Set,segmentKindById:new Map},p=[];(s??[]).forEach((e,t)=>{let r=_(e,t,f,n);r&&p.push(r)});let m=[];(l??[]).forEach((e,t)=>{let r=v(e,t,f,n);r&&m.push(r)});let h=[];return(u??[]).forEach((e,t)=>{let r=b(e,t,f,n);r&&h.push(r)}),p.length===0&&m.length===0?(n.push(i,`図形(entities)またはセグメント(segments)が1つも無く、プロファイルを作れません`),null):{authoringId:a,feature:{type:`sketch`,id:r(`sketch`),name:`Sketch${t+1}`,plane:{kind:`world`,plane:o},entities:p,...m.length>0?{segments:m}:{},...h.length>0?{constraints:h}:{}}}}function S(e,t,n,r){if(e==null)return n.bodyFeatureIds.length===0?(r.push(t,`まだボディが1つも作られていない状態でcut/add操作を行おうとしています(先にoperation:"newBody"のフィーチャーが必要です)`),{ok:!1}):{ok:!0};if(!d(e))return r.push(`${t}.targetBody`,`文字列またはnullである必要があります`),{ok:!1};let i=n.featureIdMap.get(e);return!i||!n.bodyFeatureIds.includes(i)?(r.push(t,`"${e}" というIDの対象ボディ(newBody操作のフィーチャー)が見つかりません`),{ok:!1}):{targetBodyId:i,ok:!0}}function C(e,t,n,r,i){return e==null?!0:d(e)?r.featureIdMap.has(e)?(i.push(n,`フィーチャーID "${e}" が重複しています`),!1):(r.featureIdMap.set(e,t),!0):(i.push(`${n}.id`,`文字列またはnullである必要があります`),!1)}function w(e,t,n,i){let a=`features[${t}]`;if(!c(e))return i.push(a,`オブジェクトである必要があります`),null;let o=e.type,s=e.sketch;if(!d(s))return i.push(`${a}.sketch`,`空でない文字列である必要があります`),null;let f=n.sketchIdMap.get(s);if(!f)return i.push(`${a}.sketch`,`"${s}" というIDのスケッチがありません`),null;let p=e.operation;if(p!==`newBody`&&p!==`add`&&p!==`cut`)return i.push(`${a}.operation`,`"newBody"/"add"/"cut"のいずれかである必要があります`),null;if(o===`extrude`){let t=e.distance;if(!u(t))return i.push(`${a}.distance`,`正の数である必要があります`),null;let o=e.direction,s=1;if(o!=null){if(o!==1&&o!==-1)return i.push(`${a}.direction`,`1、-1、またはnullである必要があります`),null;s=o}let c=r(`extrude`);if(!C(e.id,c,a,n,i))return null;let l=p===`newBody`?{ok:!0}:S(e.targetBody,a,n,i);if(!l.ok)return null;n.extrudeCount+=1;let d={type:`extrude`,id:c,name:`Extrude${n.extrudeCount}`,sketchId:f,distance:t,direction:s,operation:p,...l.targetBodyId?{targetBodyId:l.targetBodyId}:{}};return p===`newBody`&&n.bodyFeatureIds.push(c),d}if(o===`revolve`){let t=e.axis;if(t!==`x`&&t!==`y`)return i.push(`${a}.axis`,`"x"または"y"である必要があります`),null;let o=e.angle,s=360;if(o!=null){if(!l(o)||o<=0||o>360)return i.push(`${a}.angle`,`0より大きく360以下の数値、またはnullである必要があります`),null;s=o}let c=r(`revolve`);if(!C(e.id,c,a,n,i))return null;let u=p===`newBody`?{ok:!0}:S(e.targetBody,a,n,i);if(!u.ok)return null;n.revolveCount+=1;let d={type:`revolve`,id:c,name:`Revolve${n.revolveCount}`,sketchId:f,axis:t,angle:s,operation:p,...u.targetBodyId?{targetBodyId:u.targetBodyId}:{}};return p===`newBody`&&n.bodyFeatureIds.push(c),d}return i.push(`${a}.type`,`未対応のフィーチャー種別です: ${JSON.stringify(o)}("extrude"または"revolve")`),null}function ee(e){let t=new s;if(!c(e))return t.push(`root`,`JSONオブジェクトである必要があります`),{errors:t.errors};if(Array.isArray(e.sketches)||t.push(`sketches`,`配列である必要があります`),Array.isArray(e.features)||t.push(`features`,`配列である必要があります`),t.hasErrors)return{errors:t.errors};let n=e.sketches,r=e.features;n.length===0&&t.push(`sketches`,`少なくとも1つのスケッチが必要です`),r.length===0&&t.push(`features`,`少なくとも1つのフィーチャー(extrude/revolve)が必要です`);let i=[],a=new Map,o=new Set;n.forEach((e,n)=>{let r=x(e,n,t);if(r){if(o.has(r.authoringId)){t.push(`sketches[${n}]`,`スケッチID "${r.authoringId}" が重複しています`);return}o.add(r.authoringId),a.set(r.authoringId,r.feature.id),i.push(r.feature)}});let l={sketchIdMap:a,featureIdMap:new Map,bodyFeatureIds:[],extrudeCount:0,revolveCount:0},u=[];return r.forEach((e,n)=>{let r=w(e,n,l,t);r&&u.push(r)}),t.hasErrors?{errors:t.errors}:{doc:{version:1,features:[...i,...u]}}}var T={type:`array`,items:{type:`number`}},E={anyOf:[{type:`object`,properties:{kind:{const:`rectangle`},id:{type:`string`},center:T,width:{type:`number`},height:{type:`number`}},required:[`kind`,`id`,`center`,`width`,`height`],additionalProperties:!1},{type:`object`,properties:{kind:{const:`circle`},id:{type:`string`},center:T,radius:{type:`number`}},required:[`kind`,`id`,`center`,`radius`],additionalProperties:!1},{type:`object`,properties:{kind:{const:`polygon`},id:{type:`string`},points:{type:`array`,items:T}},required:[`kind`,`id`,`points`],additionalProperties:!1},{type:`object`,properties:{kind:{const:`slot`},id:{type:`string`},start:T,end:T,width:{type:`number`}},required:[`kind`,`id`,`start`,`end`,`width`],additionalProperties:!1},{type:`object`,properties:{kind:{const:`regularPolygon`},id:{type:`string`},center:T,radius:{type:`number`},sides:{type:`integer`},rotation:{anyOf:[{type:`number`},{type:`null`}]}},required:[`kind`,`id`,`center`,`radius`,`sides`,`rotation`],additionalProperties:!1}]},te={anyOf:[{type:`object`,properties:{kind:{const:`line`},id:{type:`string`},p1:T,p2:T},required:[`kind`,`id`,`p1`,`p2`],additionalProperties:!1},{type:`object`,properties:{kind:{const:`arc`},id:{type:`string`},p1:T,p2:T,bulge:{type:`number`}},required:[`kind`,`id`,`p1`,`p2`,`bulge`],additionalProperties:!1}]},D={type:`object`,properties:{segment:{type:`string`},point:{enum:[`start`,`end`]}},required:[`segment`,`point`],additionalProperties:!1},O={type:`object`,properties:{design:{anyOf:[{type:`string`},{type:`null`}]},questions:{anyOf:[{type:`array`,items:{type:`object`,properties:{question:{type:`string`},options:{type:`array`,items:{type:`string`}}},required:[`question`,`options`],additionalProperties:!1}},{type:`null`}]},model:{anyOf:[{type:`object`,properties:{sketches:{type:`array`,items:{type:`object`,properties:{id:{type:`string`},plane:{enum:[`XY`,`XZ`,`YZ`]},entities:{type:`array`,items:E},segments:{type:`array`,items:te},constraints:{type:`array`,items:{anyOf:[{type:`object`,properties:{kind:{const:`distance`},a:D,b:D,value:{type:`number`}},required:[`kind`,`a`,`b`,`value`],additionalProperties:!1},{type:`object`,properties:{kind:{const:`radius`},segment:{type:`string`},value:{type:`number`}},required:[`kind`,`segment`,`value`],additionalProperties:!1},{type:`object`,properties:{kind:{const:`horizontal`},segment:{type:`string`}},required:[`kind`,`segment`],additionalProperties:!1},{type:`object`,properties:{kind:{const:`vertical`},segment:{type:`string`}},required:[`kind`,`segment`],additionalProperties:!1},{type:`object`,properties:{kind:{const:`coincident`},a:D,b:D},required:[`kind`,`a`,`b`],additionalProperties:!1}]}}},required:[`id`,`plane`,`entities`,`segments`,`constraints`],additionalProperties:!1}},features:{type:`array`,items:{anyOf:[{type:`object`,properties:{type:{const:`extrude`},id:{anyOf:[{type:`string`},{type:`null`}]},sketch:{type:`string`},distance:{type:`number`},operation:{enum:[`newBody`,`add`,`cut`]},direction:{anyOf:[{const:1},{const:-1},{type:`null`}]},targetBody:{anyOf:[{type:`string`},{type:`null`}]}},required:[`type`,`id`,`sketch`,`distance`,`operation`,`direction`,`targetBody`],additionalProperties:!1},{type:`object`,properties:{type:{const:`revolve`},id:{anyOf:[{type:`string`},{type:`null`}]},sketch:{type:`string`},axis:{enum:[`x`,`y`]},angle:{anyOf:[{type:`number`},{type:`null`}]},operation:{enum:[`newBody`,`add`,`cut`]},targetBody:{anyOf:[{type:`string`},{type:`null`}]}},required:[`type`,`id`,`sketch`,`axis`,`angle`,`operation`,`targetBody`],additionalProperties:!1}]}}},required:[`sketches`,`features`],additionalProperties:!1},{type:`null`}]}},required:[`design`,`questions`,`model`],additionalProperties:!1},k=`# アプリの概要
- 単位は常にミリメートル(mm)。
- モデルは「フィーチャーツリー」(スケッチ→押し出し(extrude)/回転体(revolve)、の順序付きリスト)で構成されるパラメトリックCADです。
- スケッチは平面(XY/XZ/YZのいずれか)上の2D図形で、押し出しまたは回転体で3Dボディになります。
- 入れ子になったプロファイル(例: 長方形の内側に円)は自動的に穴として扱われます(内側の図形の押し出しが外側の図形の押し出しから差し引かれる)。穴を開けたい場合は、外形の内側に穴の図形を追加するだけで構いません。別途カット操作を書く必要はありません。
- 複数のボディを作る場合や、既存ボディに追加(add)・削除(cut)する場合は、features配列に複数のextrude/revolveを順番に並べます。

# 平面と押し出し・回転方向(重要)

| plane | スケッチのx | スケッチのy | direction:1の押し出し方向 |
|---|---|---|---|
| XY | 世界X | 世界Y | 世界 +Z(上) |
| XZ | 世界X | 世界Z(高さ) | 世界 +Y |
| YZ | 世界Y | 世界Z(高さ) | 世界 +X |

**床に置く製品(スタンド・ケース・治具など)は、側面断面をXZ平面に描き、幅方向へ押し出すのが基本です。** このときスケッチのy=0が接地面になります。yが負の領域に外形を置かないでください(床にめり込みます)。板物・プレート類はXY平面に描いて上方向に押し出します。押し出し量が「幅」になる場合、断面の設計に全神経を注いでください。このアプリの表現力は、事実上すべて断面形状で決まります。

回転体(revolve)のaxisは、スケッチのローカルx軸("x")またはy軸("y")のどちらかを、スケッチ原点を通る直線として使います(上表の「スケッチのx/y」列がそのままワールド方向になります)。**回転軸はスケッチ平面に含まれる直線として扱われるので、断面はその軸をまたがない位置に置いてください**(軸をまたぐと不正な形状になります)。床の上で自立するリング状・碗状の部品(回転軸を鉛直にしたい場合)は、断面をXZまたはYZ平面に描き、axis:"y"(世界Z、鉛直)を使ってください。
**回転軸は必ずスケッチ原点を通り、位置をずらすことはできません。** そのため複数の回転体は全て同じ軸(原点)上に配置されます。回転体を含む複数部品(例:「受け皿あり」)は、横に並べるのではなく**同軸の組み立て状態(積み重ね・入れ子)**として設計してください。
`,A=`# 図形(entities)の種類
- rectangle: { kind, id, center:[x,y], width, height } — 中心座標と幅・高さ
- circle: { kind, id, center:[x,y], radius }
- polygon: { kind, id, points:[[x,y], ...] } — 3点以上の順序付き頂点(最後と最初は自動で結ばれる)
- slot: { kind, id, start:[x,y], end:[x,y], width } — 直線状の長円(角丸長方形、start/endは中心線の両端、widthは全幅)
- regularPolygon: { kind, id, center:[x,y], radius, sides, rotation } — 外接円半径radius、辺数sides(3〜24)、rotation(ラジアン、任意角度からの回転、省略時はnull)

すべてのオブジェクトについて、上記に無いフィールドを追加してはいけません。省略可能なフィールドは値が無ければ必ずnullにしてください(フィールド自体を省略しないでください)。

# segments/constraints(原則として使わない)
entitiesは既に正確な数値で位置・サイズを指定できるため、ほぼすべての形状はentitiesだけで表現できます。**曲線を作る目的でsegmentsのarcを使わないでください。曲線はpolygonの頂点を密に並べた近似で作ります(次章参照)。** segments(自由な線分・円弧チェーン)とconstraints(拘束)は、「この2点を一致させる」「この線は水平/垂直」「この2点間の距離をちょうど◯◯mmにする」といったPlaneGCS幾何拘束ソルバによる正確な解決が本質的に必要な場合にのみ使ってください。

segments: [{ "kind":"line", "id":"seg1", "p1":[0,0], "p2":[50,0] }, { "kind":"arc", "id":"seg2", "p1":[50,0], "p2":[50,50], "bulge":0.5 }]
(bulge = tan(挟角/4)。おおよその概形で構わず、正確な形はconstraintsで拘束すればソルバが解きます)

constraints(サポートするのはこの5種類のみ):
- { "kind":"distance", "a":{"segment":"seg1","point":"start"}, "b":{"segment":"seg2","point":"end"}, "value":50 } — 2点間の距離(mm)。同一segmentの両端点を指定すればその線分の「長さ」になる
- { "kind":"radius", "segment":"seg2", "value":10 } — 円弧segmentにのみ指定できる半径拘束(mm)
- { "kind":"horizontal", "segment":"seg1" } — 線分が水平
- { "kind":"vertical", "segment":"seg1" } — 線分が垂直
- { "kind":"coincident", "a":{"segment":"seg1","point":"end"}, "b":{"segment":"seg2","point":"start"} } — 2点が一致(線分同士を繋ぐ)

# フィーチャー(features)
- extrude: { "type":"extrude", "id", "sketch", "distance", "operation", "direction", "targetBody" }
  - operation: "newBody"(新規ボディ) | "add"(既存ボディへ追加) | "cut"(既存ボディから削除)
  - direction: 1(平面の法線正方向) | -1(逆方向) | null(省略時は1)
- revolve: { "type":"revolve", "id", "sketch", "axis", "angle", "operation", "targetBody" }
  - axis: "x" | "y"(必須)。angleは省略可(nullなら360度=全周)。operationはextrudeと同じ。

cut/addを使う場合、その前(features配列でより前)に必ずoperation:"newBody"のフィーチャーが存在している必要があります。targetBodyを省略(null)すると直前に作られたボディが自動的に対象になります。複数のボディがある場合は、対象にしたいnewBodyフィーチャーの"id"を明示的に指定し、targetBodyでそのidを参照してください。idはcut/addの対象として参照される場合のみ文字列を付け、それ以外は必ずnullにします。
**cut/addのスケッチが複数のボディと空間的に重なり得る場合は、targetBodyを必ず明示してください。** 省略(null)時は「直前に作られたボディ」が対象になるため、フィーチャーの順序が変わっただけで意図しないボディを削る事故につながります。ボディが1つしかない場合のみnullで構いません。
`,j=`# 曲線とフィレットの作り方(デザイン品質の核心)
このアプリには曲面生成機能もフィレット機能もありません。**滑らかな曲線は、polygonの頂点を密に並べて近似することで作ります。**

## 分割角の決め方
弦誤差(サジタ)sを0.05mm以下に保つ。半径rに対する分割角θ = 2 × acos(1 − s / r)。実用値(s=0.05mm):

| 半径r | 分割角の目安 | 90°弧の分割数 |
|---|---|---|
| 3mm | 21° | 5 |
| 5mm | 16° | 6 |
| 10mm | 11.5° | 8 |
| 20mm | 8° | 12 |
| 50mm | 5° | 18 |
| 75mm | 4° | 23 |

**最低でも円弧1つあたり5点。** 4点以下は「カクカクした多角形」に見えます。迷ったら90°弧を8分割(11.25°刻み)にしてください。

## フィレット(角R)は必須
**外形の角を直角のまま残さないでください。** 角の頂点を半径Rの円弧近似(5〜8点)に置き換えます。デフォルトの角R:

| 部位 | 角R |
|---|---|
| 外形の凸角(手が触れる) | R2〜R5 |
| 底面と側面の接地エッジ | R2〜R3 |
| 内側の凹角 | R3〜R6 |
| 板厚の端部 | 半円キャップ(R=板厚/2) |

**板や柱の端部は、直角に切り落とさず半円キャップで丸めると、一気に製品らしくなります。**

## 頂点の計算手順
1. 円弧の中心C=(cx,cy)と半径rを決める。凸角では中心は角の頂点から材料の内側へ、**凹角(内側R)では中心を材料側へ、角を挟む2辺それぞれからRずつオフセットした位置に取る**(凸角と向きが逆になるので注意。中心から見て弧が材料の外周をなぞる向きになっているか確認する)
2. 始点角θ1、終点角θ2を求める(atan2)
3. 分割数nを決める
4. k=0..nについて (cx + r·cos(θ1 + k·(θ2−θ1)/n), cy + r·sin(θ1 + k·(θ2−θ1)/n)) を出力する
5. 隣接要素と頂点が重複しないよう、接続点は片方だけに含める(閉多角形はpointsの最後と最初が自動で結ばれるので、同じ点を両端に重複して書かない)
6. 数値は小数第2位まで
`,M=`# 設計方針
1. **寸法はentitiesの数値で直接・正確に指定する。**「中央に」ならcenterを[0,0]にするなど、暗黙の意図を数値に落とし込む。
2. **穴は「外形の内側にもう1つ図形を追加するだけ」。** 既存の別ボディに穴を開ける場合のみoperation:"cut"を使う。
3. **実寸を先に確定させる。** 対象物(スマホ、工具、ボトル等)がある場合、その実寸を先に明確にしてから設計を始める。
4. **現実的で製造可能な寸法にする。** 最小肉厚3mm以上(3Dプリント想定)。極端に薄い・巨大すぎる値を避ける。嵌合部には片側0.5〜1.0mmのクリアランスを持たせる。
5. **「塊」で終わらせない。** 次のいずれかを必ず1つ以上使う: アーチ・トンネル状の抜き / 断面の曲線化 / 肉盗み・軽量化ポケット / テーパー / 段差やリブによるアクセント(ただし、寸法が完全に指示されている単純な機能部品では、意匠上の付加要素より寸法の正確性を優先してよい)。
6. **対称性と比率。** 意図的な非対称でない限り左右対称にする。主要寸法の比率は1:1、1:1.618、1:2のいずれかに寄せる。
`,N=`# 出力前チェックリスト
□ 物を保持する形状か? ならば「保持部の高さ > 対象物の厚み + 2mm」を満たすか
□ 重心が接地面(脚の外周)の内側に入るか(前倒れ・横倒れしないか)
□ 最小肉厚が3mm以上あるか
□ polygonの頂点が自己交差していないか、頂点順序が一貫しているか
□ 直角のまま残っている外形の凸角はないか(単純な機能部品を除く)
□ 曲線部の頂点が5点以上あるか
□ 接地面がy=0に一致しているか(負の領域にはみ出していないか)
□ cutフィーチャーの押し出し距離は対象ボディを確実に貫通する長さか
□ cut/addの前にnewBodyフィーチャーが存在するか
□ 3Dプリント時、45°を超えるオーバーハングを避けられる置き方が1つ以上あるか
□ 仕様に無いフィールドを追加していないか。省略可能フィールドをnullにしたか
`,P=[{title:`幅100 高さ50 厚み10の板の中央にφ20の穴`,design:`## 対象物の実寸
該当なし(特定の対象物を保持しない汎用の板)
## 機能要件
指示された寸法どおりの穴あき板を作る。失敗条件: 穴の位置・直径・板厚のいずれかが指示と異なること。
## 主要寸法
| 項目 | 値 | 根拠 |
|---|---|---|
| 板の幅 | 100mm | 指示どおり |
| 板の高さ | 50mm | 指示どおり |
| 板の厚み | 10mm | 指示どおり |
| 穴の直径 | 20mm(半径10mm) | 指示の「φ20」どおり |
| 穴の位置 | 板の中心(0,0) | 指示の「中央」どおり |
## 造形方針
矩形の外形の内側に円を追加し、自動的に穴として扱わせる。押し出し方向はXY平面の+Z(厚み方向)。すべての寸法が指示から一意に決まっており、フィレット等の意匠要素を追加する余地・必要が無いため、矩形のまま出力する。
`,model:{sketches:[{id:`s1`,plane:`XY`,entities:[{kind:`rectangle`,id:`outer`,center:[0,0],width:100,height:50},{kind:`circle`,id:`hole`,center:[0,0],radius:10}],segments:[],constraints:[]}],features:[{type:`extrude`,id:null,sketch:`s1`,distance:10,operation:`newBody`,direction:1,targetBody:null}]},meta:{title:`穴あきプレート 100×50×t10`,description:`幅100mm・高さ50mm・厚み10mmの板の中央にφ20mmの貫通穴を開けた汎用プレート。ネジ止めや位置決め用の下穴として使える。`,tags:[`プレート`,`板`,`穴あき`]}},{title:`幅60 高さ40 厚み8のブラケット、角にフィレット、中央に肉盗み`,design:`## 対象物の実寸
該当なし(汎用の取り付けブラケット)
## 機能要件
壁面や治具などにネジ等で固定して使う汎用ブラケット。失敗条件: 外形の角が鋭利で手を傷つける/軽量化の肉盗みで強度を落としすぎる。
## 主要寸法
| 項目 | 値 | 根拠 |
|---|---|---|
| 全体の幅 | 60mm | 指示どおり |
| 全体の高さ | 40mm | 指示どおり |
| 厚み(押し出し量) | 8mm | 指示どおり。最小肉厚3mm以上を満たす |
| 外形の角R | 6mm | 手が触れる外形の凸角のデフォルト(R2〜R5)よりやや大きめにして丸みを持たせた |
| 中央の肉盗みスロット | 幅10mm・中心間距離20mm(全長30mm) | 外周から左右15mmの肉厚を残しつつ軽量化する |
## 造形方針
60×40の矩形の4隅をR6のフィレット(円弧を6点で近似)に置き換えたpolygonを外形とし、中央にslotの肉盗みを入れ子で追加して自動的に穴として扱わせる(「塊」で終わらせないための軽量化ポケット)。XY平面に描いて厚み方向(+Z)へ8mm押し出す。左右対称。
`,model:{sketches:[{id:`s1`,plane:`XY`,entities:[{kind:`polygon`,id:`outer`,points:[[30,14],[29.71,15.85],[28.85,17.53],[27.53,18.85],[25.85,19.71],[24,20],[-24,20],[-25.85,19.71],[-27.53,18.85],[-28.85,17.53],[-29.71,15.85],[-30,14],[-30,-14],[-29.71,-15.85],[-28.85,-17.53],[-27.53,-18.85],[-25.85,-19.71],[-24,-20],[24,-20],[25.85,-19.71],[27.53,-18.85],[28.85,-17.53],[29.71,-15.85],[30,-14]]},{kind:`slot`,id:`pocket`,start:[-10,0],end:[10,0],width:10}],segments:[],constraints:[]}],features:[{type:`extrude`,id:null,sketch:`s1`,distance:8,operation:`newBody`,direction:1,targetBody:null}]},meta:{title:`取り付けブラケット 60×40×t8(角R6)`,description:`幅60mm・高さ40mm・厚み8mmの汎用取り付けブラケット。四隅をR6で丸め、中央にスロット状の肉盗みを入れて軽量化した。壁面や治具への固定に使える。`,tags:[`ブラケット`,`取り付け金具`,`軽量化`]}},{title:`外径60、内径40、高さ10のリング(床に自立、回転体)`,design:`## 対象物の実寸
該当なし(汎用のリング形状)
## 機能要件
床(架台)に置いて自立するリング状の部品。失敗条件: 内径・外径・高さが指示と異なる/接地面がy=0からずれて浮く・めり込む。
## 主要寸法
| 項目 | 値 | 根拠 |
|---|---|---|
| 外径 | 60mm(外半径30mm) | 指示どおり |
| 内径 | 40mm(内半径20mm) | 指示どおり |
| 高さ | 10mm | 指示どおり |
| 上端の角R | 1mm | 半径方向10mmしかない薄い断面のため、過大にならない程度に丸めた |
## 造形方針
断面をXZ平面(スケッチのローカルx=世界X=半径方向、ローカルy=世界Z=高さ方向)に描く。半径20〜30mm・高さ0〜10mm(y=0を接地面)の矩形の上側2隅をR1のフィレット(5点近似)にしたpolygonとし、revolveのaxisを"y"(スケッチのy軸=世界Z、鉛直)にして360°(angle:null)回転させる。回転軸(x=0の直線)を断面がまたがない(x∈[20,30]で常に正)ことを確認済み。
`,model:{sketches:[{id:`s1`,plane:`XZ`,entities:[{kind:`polygon`,id:`profile`,points:[[20,1],[20.08,.62],[20.29,.29],[20.62,.08],[21,0],[29,0],[29.38,.08],[29.71,.29],[29.92,.62],[30,1],[30,9],[29.92,9.38],[29.71,9.71],[29.38,9.92],[29,10],[21,10],[20.62,9.92],[20.29,9.71],[20.08,9.38],[20,9]]}],segments:[],constraints:[]}],features:[{type:`revolve`,id:null,sketch:`s1`,axis:`y`,angle:null,operation:`newBody`,targetBody:null}]},meta:{title:`リング(外径60×内径40×高さ10)`,description:`外径60mm・内径40mm・高さ10mmの床置き自立型リング。上端角をR1で軽く丸めた汎用形状で、スペーサーやリング状の治具に使える。`,tags:[`リング`,`回転体`,`スペーサー`]}}];function F(e,t){let n={design:e.design,questions:null,model:e.model};return`## 例${t+1}: 「${e.title}」\n${JSON.stringify(n,null,2)}`}function I(e,t){let n={model:e.model,meta:e.meta};return`## 例${t+1}: 「${e.title}」\n${JSON.stringify(n,null,2)}`}var L=[`あなたはブラウザで動くパラメトリックCADアプリ「light-3dcad」向けのモデル生成アシスタントです。
ユーザーの自然言語(主に日本語)の指示から、3D形状を表す「アウソリングJSON」を生成してください。

あなたは単なるフォーマット変換器ではなく、**プロダクトデザイナー兼機械設計者**として振る舞ってください。指示を最小限に満たす形状ではなく、「実際に使えて、見た目が整っている形状」を設計してください。

# 出力手順(必ず守ること)

応答は常に次の3フィールドを持つJSONオブジェクト1つです(説明文やMarkdownのコードフェンスは不要、JSON本体のみ)。

\`\`\`
{
  "design": string | null,
  "questions": [ { "question": string, "options": string[] } ] | null,
  "model": { "sketches": [...], "features": [...] } | null
}
\`\`\`

**design/modelの組か、questionsのどちらか一方だけを埋めてください。** 生成する場合はdesignとmodelを埋めてquestionsをnullに、質問する場合はquestionsを埋めてdesignとmodelをnullにします。両方埋めたり、両方nullのままにしたりしてはいけません。

## design(設計メモ、生成する場合は必須)
"design"には次の見出しを含むMarkdownテキストを入れてください。ここは思考の場所です。**この内容を飛ばして直接modelを書き始めてはいけません。**

\`\`\`
## 対象物の実寸
(支える・載せる・収める対象があれば、その実寸をmmで明記。型番が特定できるなら実測値、不明なら一般的な値と、そう判断した根拠を1行で。対象物が無ければ「該当なし」と書く)
## 機能要件
(何を支える/載せる/通すのか。そして「何が起きたら失敗か」を必ず1つ以上書く。例: 保持部が浅いと端末が前に滑り落ちる/脚幅が狭いと横倒しする)
## 主要寸法
| 項目 | 値 | 根拠 |
(最低5行。すべての値に「なぜその値か」を書く。「適当に決めた」寸法を1つも残さないこと)
## 造形方針
(断面をどう構成するか。曲線をどこに使うか。どこを抜いて軽く見せるか。押し出し方向をどう取るか)
\`\`\`

## questions(質問モード)
指示が曖昧で、複数の妥当な設計解が存在する場合(用途・置き方・サイズ制約・取り付け方が不明など)は、design/modelをnullにし、代わりにquestionsを埋めてください。
- 質問は最大3問。それ以上は聞かない。
- 各質問には必ず2〜4個の具体的な選択肢を添える(自由回答を求めない)。
- **判定基準: 主要寸法が指示から一意に決まるか。**「幅100 高さ50 厚み10の板の中央にφ20の穴」→一意に決まる。質問せず即生成。「iPhone用スタンド作って」→置き方・充電・デザイン方向が未定。質問する。
- **一度質問して、ユーザーからの回答(選択結果)を含むメッセージを受け取ったら、以後は絶対に再度質問せず、その回答に基づいて生成してください。** 回答が「おまかせ」の項目は、あなたの判断で妥当な設計を選んでください。

以下は"model"フィールド(アウソリングJSON本体)の詳細仕様です。
`,k,A,j,M,N,`# few-shot例\n\n${P.map(F).join(`

`)}`,`# 禁止事項
- design(生成する場合)を省略して直接modelを出力すること
- 仕様に無いフィールドの追加
- 省略可能フィールドの省略(必ずnullにする)
- 曲線を4点以下のpolygonで表現すること
- 外形の凸角をすべて直角のまま残すこと(単純な機能部品を除く)
- 対象物の実寸を確認せずに保持寸法を決めること
- 曖昧な指示に対して質問もせず推測だけで大きな設計判断を下すこと
- 一度回答を受け取ったのに再度questionsを返すこと
- design/questions/modelを中途半端に埋めること(生成する場合はdesign+modelのみ、質問する場合はquestionsのみ埋め、他はnullにする)
`,`出力するJSONは、この仕様に厳密に従ってください。`].join(`
`),ne=[`あなたはブラウザで動くパラメトリックCADアプリ「light-3dcad」向けのモデル生成アシスタントです。
ユーザーの自然言語(主に日本語)の指示から、3D形状を表す「アウソリングJSON」と、そのモデルをコミュニティギャラリーに投稿する際のタイトル/説明/タグの提案を1つずつ生成してください。

あなたは単なるフォーマット変換器ではなく、**プロダクトデザイナー兼機械設計者**として振る舞ってください。指示を最小限に満たす形状ではなく、「実際に使えて、見た目が整っている形状」を設計してください。対象物の実寸・機能要件・主要寸法の根拠・造形方針を頭の中で整理してから(必要ならJSONの外に短いメモとして書き出してから)、最後にJSON本体を出力してください。

# 出力形式
最終的な出力は次の形のJSONオブジェクト1つだけです(このJSONの直前にメモを書くのは構いませんが、JSON自体にはコードフェンスを付け、説明文と明確に分離してください)。

\`\`\`
{
  "model": {
    "sketches": [ { "id": "s1", "plane": "XY", "entities": [...], "segments": [], "constraints": [] } ],
    "features": [ { "type": "extrude", "id": null, "sketch": "s1", "distance": 20, "operation": "newBody", "direction": 1, "targetBody": null } ]
  },
  "meta": {
    "title": "短い日本語のモデル名",
    "description": "寸法と用途を含む1〜3文の説明",
    "tags": ["タグ1", "タグ2"]
  }
}
\`\`\`

## meta(ギャラリー投稿用メタ情報)
- "title": 短い日本語の名前(例:「取り付けブラケット 60×40×t8」)。何のモデルかが一目でわかる長さにする。
- "description": 主要寸法と用途を含む1〜3文の日本語。「何を」「どこに」「どう使うか」がわかるように書く。
- "tags": 2〜4個の短い日本語キーワードの配列(例:["ブラケット","取り付け金具"])。用途・形状カテゴリを表す語を選ぶ。
`,k,A,j,M,N,`# few-shot例\n\n${P.map(I).join(`

`)}`,`# 禁止事項
- 仕様に無いフィールドの追加
- 省略可能フィールドの省略(必ずnullにする)
- 曲線を4点以下のpolygonで表現すること
- 外形の凸角をすべて直角のまま残すこと(単純な機能部品を除く)
- 対象物の実寸を確認せずに保持寸法を決めること
- 最終的なJSON本体をコードフェンス無しで出力すること、または複数のJSONを出力すること
- meta(title/description/tags)を省略すること
`,`出力するJSONは、この仕様に厳密に従ってください。`].join(`
`),R=class extends Error{},z=async e=>{let t=await a(()=>import(`./sdk-CJodkDwg.js`).then(e=>e.t),__vite__mapDeps([0,1,2,3])),n=t.default,r=new n({apiKey:e.apiKey,dangerouslyAllowBrowser:!0});try{let t=await r.messages.stream({model:e.model,max_tokens:16e3,system:e.system,messages:e.messages.map(e=>({role:e.role,content:e.content})),output_config:{format:{type:`json_schema`,schema:O}}}).finalMessage();if(t.stop_reason===`refusal`)return{text:``,stopReason:`refusal`};let n=t.content.find(e=>e.type===`text`);if(!n||n.type!==`text`)throw new R(`AIの応答にテキストが含まれていませんでした(想定外の応答形式です)`);return{text:n.text,stopReason:t.stop_reason??`end_turn`}}catch(e){throw e instanceof R?e:e instanceof t.AuthenticationError?new R(`APIキーが無効です。設定を確認してください。`):e instanceof t.PermissionDeniedError?new R(`このAPIキーには権限がありません。`):e instanceof t.RateLimitError?new R(`APIのレート制限に達しました。しばらく待ってから再試行してください。`):e instanceof t.NotFoundError?new R(`指定したモデルが見つかりません。モデル名を確認してください。`):e instanceof t.APIConnectionError?new R(`Anthropic APIに接続できませんでした。ネットワーク接続を確認してください。`):e instanceof t.APIError?new R(`Anthropic APIエラー: ${e.message}`):new R(e instanceof Error?e.message:String(e))}},B=async e=>{let{useCadStore:t}=await a(async()=>{let{useCadStore:e}=await import(`./index-BBxzI3Vw.js`).then(e=>e.r);return{useCadStore:e}},__vite__mapDeps([2,1,3]));return t.getState().dryRunEvaluate(e)},V=async e=>{let t=await a(()=>import(`./index-BBxzI3Vw.js`).then(e=>e.a),__vite__mapDeps([2,1,3]));return await t.ensureGcsInitialized(),t.solveDocumentSketchesAsync(e)},H=`すべておまかせで生成してください`;function U(e){return`生成されたJSONに次のエラーがありました。エラーを修正した上で、指定されたJSONオブジェクトのみを出力し直してください(説明文やコードフェンスは不要です):\n${e.map(e=>`- ${e}`).join(`
`)}`}function re(e){if(typeof e!=`object`||!e||Array.isArray(e))return{kind:`invalid`,message:`応答はJSONオブジェクトである必要があります`};let t=e,n=t.questions;if(n!=null){if(!Array.isArray(n)||n.length<1||n.length>3)return{kind:`invalid`,message:`questionsは1〜3件の配列である必要があります`};let e=[];for(let t of n){if(typeof t!=`object`||!t)return{kind:`invalid`,message:`questionsの各項目はオブジェクトである必要があります`};let n=t,r=n.options;if(typeof n.question!=`string`||!Array.isArray(r)||r.length<2||r.length>4||!r.every(e=>typeof e==`string`))return{kind:`invalid`,message:`questionsの各項目はquestion(文字列)とoptions(2〜4件の文字列配列)を持つ必要があります`};e.push({question:n.question,options:r})}return{kind:`questions`,questions:e}}let r=t.design,i=t.model;return typeof r==`string`&&i!=null?{kind:`document`,design:r,model:i}:{kind:`invalid`,message:`応答はdesign+model(生成)、またはquestions(質問)のいずれかの形式である必要があります`}}async function ie(e){let t=e.maxAttempts??3,n=e.callModel??z,r=e.dryRunEvaluate??B,i=e.solveSketches??V,a=e.conversation?[...e.conversation]:[{role:`user`,content:e.prompt}],o=[],s=!1;for(let c=1;c<=t;c+=1){e.onProgress?.({attempt:c,maxAttempts:t,phase:`generating`});let l;try{l=await n({apiKey:e.apiKey,model:e.model,system:L,messages:a})}catch(e){return{ok:!1,message:e instanceof Error?e.message:String(e),transcript:{attempts:c,repaired:o}}}if(l.stopReason===`refusal`)return{ok:!1,message:`AIモデルがこのリクエストの生成を拒否しました(安全上の理由)。プロンプトの内容を見直すか、別の表現でお試しください。`,transcript:{attempts:c,repaired:o}};let u;try{u=JSON.parse(l.text)}catch(e){let n=`AIの出力をJSONとして解析できませんでした: ${e instanceof Error?e.message:String(e)}`;if(c>=t){o.push({attempt:c,errors:[n]});break}a.push({role:`assistant`,content:l.text}),a.push({role:`user`,content:U([n])}),o.push({attempt:c,errors:[n]});continue}let d=re(u);if(d.kind===`invalid`){let e=`応答の形式が仕様(design+model または questions)に従っていません: ${d.message}`;if(c>=t){o.push({attempt:c,errors:[e]});break}a.push({role:`assistant`,content:l.text}),a.push({role:`user`,content:U([e])}),o.push({attempt:c,errors:[e]});continue}if(d.kind===`questions`){if(!(e.answeringQuestions===!0||s))return a.push({role:`assistant`,content:l.text}),{ok:!0,kind:`questions`,questions:d.questions,conversation:a,transcript:{attempts:c,repaired:o}};if(s)return{ok:!1,message:`AIが回答済みにもかかわらず再度質問してきたため、生成を中止しました。プロンプトをより具体的にして再試行してください。`,transcript:{attempts:c,repaired:o}};a.push({role:`assistant`,content:l.text}),a.push({role:`user`,content:H}),s=!0,o.push({attempt:c,errors:[`AIが回答済みにもかかわらず再度質問しました(「すべておまかせで生成してください」と自動応答しました)`]});continue}e.onProgress?.({attempt:c,maxAttempts:t,phase:`compiling`});let f=ee(d.model);if(`errors`in f){if(c>=t){o.push({attempt:c,errors:f.errors});break}a.push({role:`assistant`,content:l.text}),a.push({role:`user`,content:U(f.errors)}),o.push({attempt:c,errors:f.errors});continue}e.onProgress?.({attempt:c,maxAttempts:t,phase:`solving`});let p;try{p=await i(f.doc)}catch(e){let n=`スケッチ拘束の求解中にエラーが発生しました: ${e instanceof Error?e.message:String(e)}`;if(c>=t){o.push({attempt:c,errors:[n]});break}a.push({role:`assistant`,content:l.text}),a.push({role:`user`,content:U([n])}),o.push({attempt:c,errors:[n]});continue}if(p.conflict){let e=`スケッチ拘束が矛盾しています${p.conflict.featureId?`(${p.conflict.featureId})`:``}: ${p.conflict.message}`;if(c>=t){o.push({attempt:c,errors:[e]});break}a.push({role:`assistant`,content:l.text}),a.push({role:`user`,content:U([e])}),o.push({attempt:c,errors:[e]});continue}e.onProgress?.({attempt:c,maxAttempts:t,phase:`evaluating`});let m;try{m=await r(p.doc)}catch(e){let n=`形状の評価中にエラーが発生しました: ${e instanceof Error?e.message:String(e)}`;if(c>=t){o.push({attempt:c,errors:[n]});break}a.push({role:`assistant`,content:l.text}),a.push({role:`user`,content:U([n])}),o.push({attempt:c,errors:[n]});continue}if(m.kind!==`evaluated`){let e=m.kind===`error`?`形状の評価に失敗しました${m.featureId?`(${m.featureId})`:``}: ${m.message}`:`形状の評価で予期しない応答を受け取りました: ${m.kind}`;if(c>=t){o.push({attempt:c,errors:[e]});break}a.push({role:`assistant`,content:l.text}),a.push({role:`user`,content:U([e])}),o.push({attempt:c,errors:[e]});continue}return{ok:!0,kind:`document`,doc:p.doc,design:d.design,transcript:{attempts:c,repaired:o}}}return{ok:!1,message:`${t}回試行しましたが、有効なモデルを生成できませんでした。`,transcript:{attempts:t,repaired:o}}}function W(e){let t=e.trim(),n=/^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);if(n)return n[1].trim();let r=/```[^\n]*\n([\s\S]*?)```/.exec(t);return r?r[1].trim():t}function G(e){return typeof e==`object`&&!!e&&!Array.isArray(e)}function K(e){return G(e)?{title:typeof e.title==`string`?e.title:``,description:typeof e.description==`string`?e.description:``,tags:Array.isArray(e.tags)?e.tags.filter(e=>typeof e==`string`):[]}:null}function ae(e){let t=W(e),n;try{n=JSON.parse(t)}catch(e){return{ok:!1,error:`JSONの解析に失敗しました: ${e instanceof Error?e.message:String(e)}`}}return G(n)?`model`in n?{ok:!0,model:n.model,meta:K(n.meta)}:{ok:!0,model:n,meta:null}:{ok:!1,error:`JSONオブジェクトである必要があります`}}var q=async e=>{let t=await a(()=>import(`./openai-DXamD0N2.js`),[]),n=t.default,r=new n({apiKey:e.apiKey,dangerouslyAllowBrowser:!0});try{let t=await r.responses.create({model:e.model,instructions:e.system,input:e.messages.map(e=>({role:e.role,content:e.content})),max_output_tokens:16e3,text:{format:{type:`json_schema`,name:`ai_response_envelope`,schema:O,strict:!0}}});if(t.output.some(e=>e.type===`message`&&e.content.some(e=>e.type===`refusal`)))return{text:``,stopReason:`refusal`};let n=t.output_text;if(!n)throw new R(`AIの応答にテキストが含まれていませんでした(想定外の応答形式です)`);return{text:n,stopReason:`end_turn`}}catch(e){throw e instanceof R?e:e instanceof t.AuthenticationError?new R(`APIキーが無効です。設定を確認してください。`):e instanceof t.PermissionDeniedError?new R(`このAPIキーには権限がありません。`):e instanceof t.RateLimitError?new R(`APIのレート制限に達しました。しばらく待ってから再試行してください。`):e instanceof t.NotFoundError?new R(`指定したモデルが見つかりません。モデル名を確認してください。`):e instanceof t.APIConnectionError?new R(`OpenAI APIに接続できませんでした。ネットワーク接続を確認してください。`):e instanceof t.APIError?new R(`OpenAI APIエラー: ${e.message}`):new R(e instanceof Error?e.message:String(e))}},oe=[`anthropic`,`openai`],se={anthropic:`Anthropic (Claude)`,openai:`OpenAI (GPT)`};function ce(e){switch(e){case`anthropic`:return z;case`openai`:return q}}var J=n(),Y=`light-3dcad:ai:provider:v1`,X={anthropic:`light-3dcad:ai:apiKey:v1`,openai:`light-3dcad:ai:apiKey:openai:v1`},le={anthropic:`light-3dcad:ai:model:v1`,openai:`light-3dcad:ai:model:openai:v1`},ue=[{value:`claude-opus-5`,label:`Claude Opus 5(既定・高精度)`},{value:`claude-sonnet-5`,label:`Claude Sonnet 5(バランス)`},{value:`claude-haiku-4-5`,label:`Claude Haiku 4.5(高速・低コスト)`}],de=[{value:`gpt-5.5`,label:`GPT-5.5(既定・高精度)`},{value:`gpt-5.4`,label:`GPT-5.4(バランス)`},{value:`gpt-5.4-mini`,label:`GPT-5.4 mini(高速・低コスト)`}],Z={anthropic:`claude-opus-5`,openai:`gpt-5.5`},Q=`anthropic`,fe={anthropic:`sk-ant-...`,openai:`sk-...`};function pe(e){return e===`anthropic`||e===`openai`}function $(){if(typeof localStorage>`u`)return Q;try{let e=localStorage.getItem(Y);return pe(e)?e:Q}catch{return Q}}function me(e){if(!(typeof localStorage>`u`))try{localStorage.setItem(Y,e)}catch{}}function he(e){if(typeof localStorage>`u`)return``;try{return localStorage.getItem(X[e])??``}catch{return``}}function ge(e){if(typeof localStorage>`u`)return Z[e];try{return localStorage.getItem(le[e])??Z[e]}catch{return Z[e]}}function _e(e,t){if(!(typeof localStorage>`u`))try{t?localStorage.setItem(X[e],t):localStorage.removeItem(X[e])}catch{}}function ve(e,t){if(!(typeof localStorage>`u`))try{localStorage.setItem(le[e],t)}catch{}}var ye={generating:`生成中`,compiling:`検証中`,solving:`検証中`,evaluating:`評価中`};function be({onClose:e,onLoad:t}){let[n,r]=(0,o.useState)($),[a,s]=(0,o.useState)(()=>he($())),[c,l]=(0,o.useState)(()=>ge($())),[u,d]=(0,o.useState)(``),[f,p]=(0,o.useState)(!1),[m,h]=(0,o.useState)(null),[g,_]=(0,o.useState)(null),[v,y]=(0,o.useState)(null),[b,x]=(0,o.useState)(null),[S,C]=(0,o.useState)({}),[w,T]=(0,o.useState)({}),[E,te]=(0,o.useState)(null),[D,O]=(0,o.useState)(!1),[k,A]=(0,o.useState)(!1),[j,M]=(0,o.useState)(!1),[N,P]=(0,o.useState)(``),[F,I]=(0,o.useState)(null),[L,R]=(0,o.useState)(null),[z,B]=(0,o.useState)(!1),[V,H]=(0,o.useState)(null);(0,o.useEffect)(()=>{if(!L)return;let e=setTimeout(()=>R(null),2500);return()=>clearTimeout(e)},[L]);function U(e){r(e),me(e),s(he(e)),l(ge(e))}function re(e){s(e),_e(n,e)}function W(e){l(e),ve(n,e)}async function G(){if(!f){if(!a.trim()){_(`APIキーを入力してください`);return}if(!u.trim()){_(`プロンプトを入力してください`);return}p(!0),_(null),y(null),x(null),C({}),T({}),A(!1),h({attempt:1,maxAttempts:3,phase:`generating`});try{q(await ie({apiKey:a.trim(),model:c,prompt:u.trim(),callModel:ce(n),onProgress:e=>h(e)}))}catch(e){_(e instanceof Error?e.message:String(e))}finally{p(!1),h(null)}}}async function K(e){if(f||!b||!v)return;let t=v.map((t,n)=>{let r=w[n]?.trim(),i=e?`おまかせ`:r||S[n]||`おまかせ`;return`${n+1}. ${i}`}).join(` / `);p(!0),_(null),h({attempt:1,maxAttempts:3,phase:`generating`});try{q(await ie({apiKey:a.trim(),model:c,prompt:u.trim(),conversation:[...b,{role:`user`,content:t}],answeringQuestions:!0,callModel:ce(n),onProgress:e=>h(e)}))}catch(e){_(e instanceof Error?e.message:String(e))}finally{p(!1),h(null)}}function q(e){if(!e.ok){_(e.message);return}if(e.kind===`questions`){y(e.questions),x(e.conversation),C({}),T({});return}y(null),x(null),te(e.design),A(!0),t(e.doc)}function Y(){I(null),B(!1),H(null);let e=ae(N);if(!e.ok){I(e.error);return}let n=ee(e.model);if(`errors`in n){I(n.errors.join(`
`));return}t(n.doc),e.meta&&i.getState().setPendingGalleryMeta(e.meta),B(!0),H(e.meta)}async function X(){try{await navigator.clipboard.writeText(ne),R(`プロンプト仕様をコピーしました`)}catch(e){R(`コピーに失敗しました: ${e instanceof Error?e.message:String(e)}`)}}return(0,J.jsx)(`div`,{"data-testid":`ai-generate-backdrop`,style:{position:`fixed`,inset:0,background:`rgba(0,0,0,0.5)`,display:`flex`,alignItems:`flex-start`,justifyContent:`center`,zIndex:1e3,paddingTop:40},onMouseDown:t=>{t.target===t.currentTarget&&e()},children:(0,J.jsxs)(`div`,{"data-testid":`ai-generate-panel`,style:{background:`#242424`,color:`#eee`,border:`1px solid #555`,borderRadius:8,padding:16,width:480,maxWidth:`90vw`,maxHeight:`85vh`,overflowY:`auto`,display:`flex`,flexDirection:`column`,gap:10},children:[(0,J.jsxs)(`div`,{style:{display:`flex`,justifyContent:`space-between`,alignItems:`center`},children:[(0,J.jsx)(`h2`,{style:{margin:0,fontSize:16},children:`AI生成`}),(0,J.jsx)(`button`,{type:`button`,"data-testid":`btn-ai-close`,onClick:e,children:`閉じる`})]}),(0,J.jsx)(`p`,{style:{margin:0,fontSize:12,lineHeight:1.6,color:`#ccc`},children:`ChatGPTやClaudeなど、お好みのAIチャットで使えます。APIキー不要。`}),(0,J.jsx)(`button`,{type:`button`,"data-testid":`btn-ai-copy-prompt-spec`,onClick:X,children:`プロンプト仕様をコピー`}),L&&(0,J.jsx)(`p`,{style:{margin:0,fontSize:11,color:`#9cf`},"data-testid":`ai-copy-notice`,children:L}),(0,J.jsxs)(`ol`,{"data-testid":`ai-usage-steps`,style:{margin:0,paddingLeft:18,fontSize:11,color:`#aaa`,lineHeight:1.7},children:[(0,J.jsx)(`li`,{children:`上のボタンでプロンプト仕様をコピー`}),(0,J.jsx)(`li`,{children:`AIチャットに貼って要望を伝える`}),(0,J.jsx)(`li`,{children:`返ってきたJSONを下に貼り付け`})]}),(0,J.jsxs)(`label`,{style:{display:`flex`,flexDirection:`column`,gap:2,fontSize:12},children:[`AIチャットの返答(JSON)を貼り付け`,(0,J.jsx)(`textarea`,{"data-testid":`ai-paste-json-textarea`,value:N,onChange:e=>P(e.target.value),rows:6,placeholder:`{"model": {"sketches": [...], "features": [...]}, "meta": {"title": "...", "description": "...", "tags": ["..."]}}`})]}),(0,J.jsx)(`button`,{type:`button`,"data-testid":`btn-ai-paste-load`,onClick:Y,children:`読み込む`}),F&&(0,J.jsx)(`p`,{"data-testid":`ai-paste-error`,role:`alert`,style:{margin:0,fontSize:12,color:`#ff6b6b`,whiteSpace:`pre-wrap`},children:F}),z&&(0,J.jsxs)(`div`,{"data-testid":`ai-paste-loaded`,style:{display:`flex`,flexDirection:`column`,gap:4},children:[(0,J.jsx)(`p`,{style:{margin:0,fontSize:12,color:`#8f8`},children:`読み込み完了 — ドキュメントに反映しました`}),V&&(0,J.jsxs)(`p`,{"data-testid":`ai-paste-meta-notice`,style:{margin:0,fontSize:12,color:`#9cf`},children:[`投稿用メタ情報を読み込みました: `,V.title]})]}),(0,J.jsxs)(`details`,{"data-testid":`ai-advanced-details`,open:j,onToggle:e=>M(e.target.open),style:{borderTop:`1px solid #444`,paddingTop:8},children:[(0,J.jsx)(`summary`,{style:{cursor:`pointer`,fontSize:12},children:`APIキーで直接生成(上級者向け)`}),(0,J.jsxs)(`div`,{style:{display:`flex`,flexDirection:`column`,gap:10,marginTop:8},children:[(0,J.jsxs)(`label`,{style:{display:`flex`,flexDirection:`column`,gap:2,fontSize:12},children:[`プロバイダ`,(0,J.jsx)(`select`,{"data-testid":`ai-provider-select`,value:n,onChange:e=>U(e.target.value),children:oe.map(e=>(0,J.jsx)(`option`,{value:e,children:se[e]},e))})]}),(0,J.jsxs)(`label`,{style:{display:`flex`,flexDirection:`column`,gap:2,fontSize:12},children:[`APIキー(`,se[n],`)`,(0,J.jsx)(`input`,{type:`password`,"data-testid":`ai-api-key-input`,value:a,onChange:e=>re(e.target.value),placeholder:fe[n],autoComplete:`off`})]}),(0,J.jsx)(`p`,{style:{margin:0,fontSize:11,color:`#aaa`},children:`キーはこの端末のlocalStorageにのみ保存され、選択中のプロバイダのAPI以外には送信されません。`}),n===`anthropic`?(0,J.jsxs)(`label`,{style:{display:`flex`,flexDirection:`column`,gap:2,fontSize:12},children:[`モデル`,(0,J.jsx)(`select`,{"data-testid":`ai-model-select`,value:c,onChange:e=>W(e.target.value),children:ue.map(e=>(0,J.jsx)(`option`,{value:e.value,children:e.label},e.value))})]}):(0,J.jsxs)(`label`,{style:{display:`flex`,flexDirection:`column`,gap:2,fontSize:12},children:[`モデル(候補から選ぶか、直接入力できます)`,(0,J.jsx)(`input`,{type:`text`,"data-testid":`ai-model-input`,list:`ai-openai-model-options`,value:c,onChange:e=>W(e.target.value),placeholder:`gpt-5.5`,autoComplete:`off`}),(0,J.jsx)(`datalist`,{id:`ai-openai-model-options`,children:de.map(e=>(0,J.jsx)(`option`,{value:e.value,children:e.label},e.value))})]}),(0,J.jsxs)(`label`,{style:{display:`flex`,flexDirection:`column`,gap:2,fontSize:12},children:[`プロンプト`,(0,J.jsx)(`textarea`,{"data-testid":`ai-prompt-textarea`,value:u,onChange:e=>d(e.target.value),rows:4,placeholder:`例: 幅100 高さ50 厚み10の板の中央にφ20の穴`})]}),(0,J.jsx)(`button`,{type:`button`,"data-testid":`btn-ai-generate-submit`,onClick:G,disabled:f,children:f?`生成中…`:`生成`}),m&&(0,J.jsxs)(`p`,{"data-testid":`ai-generate-progress`,style:{margin:0,fontSize:12,color:`#9cf`},children:[`試行 `,m.attempt,`/`,m.maxAttempts,` — `,ye[m.phase]]}),g&&(0,J.jsx)(`p`,{"data-testid":`ai-generate-error`,role:`alert`,style:{margin:0,fontSize:12,color:`#ff6b6b`,whiteSpace:`pre-wrap`},children:g}),v&&(0,J.jsxs)(`div`,{"data-testid":`ai-questions-panel`,style:{display:`flex`,flexDirection:`column`,gap:10,borderTop:`1px solid #444`,paddingTop:8},children:[(0,J.jsx)(`p`,{style:{margin:0,fontSize:12,color:`#9cf`},"data-testid":`ai-generate-awaiting-answers`,children:`質問に回答待ち — 設計を確定するためにいくつか確認させてください`}),v.map((e,t)=>(0,J.jsxs)(`div`,{"data-testid":`ai-question-${t}`,style:{display:`flex`,flexDirection:`column`,gap:4},children:[(0,J.jsxs)(`p`,{style:{margin:0,fontSize:12},children:[t+1,`. `,e.question]}),(0,J.jsxs)(`div`,{style:{display:`flex`,flexWrap:`wrap`,gap:4},children:[e.options.map((e,n)=>{let r=S[t]===e;return(0,J.jsx)(`button`,{type:`button`,"data-testid":`ai-question-${t}-option-${n}`,onClick:()=>C(n=>({...n,[t]:e})),style:{fontSize:11,padding:`4px 8px`,borderRadius:12,border:r?`1px solid #9cf`:`1px solid #555`,background:r?`#2c4a5e`:`transparent`,color:`#eee`,cursor:`pointer`},children:e},n)}),(0,J.jsx)(`button`,{type:`button`,"data-testid":`ai-question-${t}-omakase`,onClick:()=>C(e=>({...e,[t]:`おまかせ`})),style:{fontSize:11,padding:`4px 8px`,borderRadius:12,border:S[t]===`おまかせ`?`1px solid #9cf`:`1px dashed #777`,background:S[t]===`おまかせ`?`#2c4a5e`:`transparent`,color:`#ccc`,cursor:`pointer`},children:`おまかせ`})]}),(0,J.jsxs)(`details`,{style:{fontSize:11},children:[(0,J.jsx)(`summary`,{style:{cursor:`pointer`,color:`#888`},children:`自由回答で上書き`}),(0,J.jsx)(`input`,{type:`text`,"data-testid":`ai-question-${t}-freetext`,value:w[t]??``,onChange:e=>T(n=>({...n,[t]:e.target.value})),style:{width:`100%`,marginTop:4}})]})]},t)),(0,J.jsxs)(`div`,{style:{display:`flex`,gap:8},children:[(0,J.jsx)(`button`,{type:`button`,"data-testid":`btn-ai-answer-submit`,onClick:()=>K(!1),disabled:f,children:`回答して生成`}),(0,J.jsx)(`button`,{type:`button`,"data-testid":`btn-ai-answer-all-omakase`,onClick:()=>K(!0),disabled:f,children:`全部おまかせで生成`})]})]}),k&&(0,J.jsxs)(`div`,{"data-testid":`ai-generate-loaded`,style:{display:`flex`,flexDirection:`column`,gap:6,borderTop:`1px solid #444`,paddingTop:8},children:[(0,J.jsx)(`p`,{style:{margin:0,fontSize:12,color:`#8f8`},children:`読み込み完了 — ドキュメントに反映しました`}),E&&(0,J.jsxs)(`details`,{"data-testid":`ai-design-details`,open:D,onToggle:e=>O(e.target.open),children:[(0,J.jsx)(`summary`,{style:{cursor:`pointer`,fontSize:12},children:`設計メモを表示`}),(0,J.jsx)(`pre`,{"data-testid":`ai-design-text`,style:{whiteSpace:`pre-wrap`,fontSize:11,color:`#ccc`,margin:`6px 0 0`,fontFamily:`inherit`},children:E})]})]})]})]})]})})}export{be as default};