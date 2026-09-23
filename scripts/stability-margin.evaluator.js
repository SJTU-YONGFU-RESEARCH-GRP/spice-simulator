// The stability-margin evaluator, as injected into assets/src-CMkpkg0p.js.
//
// This is a SOURCE FRAGMENT, not a module: it declares seven functions and
// exports nothing, and it is never loaded at runtime. scripts/patch-outbound.mjs
// copies it into the executor chunk, in front of the existing automatic summary
// builder, and scripts/stability-margin.oracle.mjs extracts it back out of the
// built artifact to test it. It lives here so the injection can be reviewed as
// code instead of as an escaped string inside a JSON manifest.
//
// ALL PHASES ARE IN DEGREES AND UNWRAPPED BEFORE USE.
//
// The contract it has to satisfy (enforced by scripts/stability-margin.oracle.mjs
// on the built bytes, and by scripts/check-artifacts.mjs check 18 on the tree):
//
//   smMargins(analyses) -> one phase-margin and one gain-margin record per
//     complex output of every AC analysis. Both are ALWAYS emitted; an undefined
//     margin is an `unavailable` record carrying a reason, never a missing row
//     and never a zero.
//
//   The margin is measured RELATIVE TO THE LOOP'S LOW-FREQUENCY PHASE, not
//     against absolute 0 and -180. A single-pole non-inverting loop sits at 0
//     deg; the same loop with an inverting stage sits at 180 deg and has exactly
//     the same stability margin. Measuring against absolute -180 would report
//     275 deg for the inverting case and, worse, would fail to notice that the
//     same loop had gone unstable: it would need to lag a full extra 180 deg
//     before the test noticed. So the threshold is smStatic(phase) - 180.
//
//   smRecord(...) -> a record shaped exactly like the artifact schema allows.
//     The metric must be a member of the enum in files-DP-BVVb4.js, and
//     `evidence` must be the schema's own aggregate ({kind:'point',coordinate}),
//     not an invented shape.
//
//   smCross(abscissa, values, level) -> every crossing of that LEVEL. Comparing
//     against the level rather than against zero is the point: a sign test would
//     read the +/-180 wrap as a crossing and would report a gain margin for a
//     phase that merely passed through 0.
//
// Lines beginning with // are stripped before injection.
function smCross(e,t,n){let r=[];for(let i=1;i<Math.min(e.length,t.length);i++){let a=t[i-1],o=t[i],s=e[i-1],c=e[i];if(!Number.isFinite(a)||!Number.isFinite(o)||!Number.isFinite(s)||!Number.isFinite(c))continue;if(a===n){r.push({x:s,i:i});continue}if((a-n)*(o-n)<0){let e=(n-a)/(o-a);r.push({x:s+(c-s)*e,i:i})}}return r}
function smInterp(e,t,n){for(let r=1;r<Math.min(e.length,t.length);r++){let i=t[r-1],a=t[r],o=e[r-1],s=e[r];if(!Number.isFinite(i)||!Number.isFinite(a)||!Number.isFinite(o)||!Number.isFinite(s))continue;if(o<=n&&n<=s){let e=s===o?0:(n-o)/(s-o);return i+(a-i)*e}}return null}
function smUnwrap(e){let t=[],n=null;for(let r of e){if(r==null||!Number.isFinite(r)){t.push(null);continue}let e=r;if(n!=null){for(;e-n>180;)e-=360;for(;e-n<-180;)e+=360}n=e;t.push(e)}return t}
function smStatic(e){for(let t of e)if(t!=null&&Number.isFinite(t))return Math.round(t/180)*180;return 0}
function smPassed(e,t,n){for(let r=0;r<Math.min(t,e.length);r++){let i=e[r];if(i!=null&&i<=n)return!0}return!1}
function smMargins(e){let t=[];return e.forEach((e,n)=>{if(e.analysis!==`ac`)return;let r=e.domain?.values??[];if(!r.length)return;for(let i of e.outputs){if(!i.imaginary)continue;let a=i.values,o=i.imaginary,s=a.length,c=[],l=[];for(let e=0;e<s;e++){let t=a[e],n=o[e];c.push(t==null||n==null?null:20*Math.log10(Math.max(Math.hypot(t,n),1e-30)));l.push(t==null||n==null?null:Math.atan2(n,t)*180/Math.PI)}let w=smUnwrap(l),z=smStatic(w),q=z-180,u=null;for(let e=0;e<r.length;e++){if(!Number.isFinite(r[e])||r[e]<=0){u=null;break}u=u||[];u.push(Math.log10(r[e]))}let d=u?smCross(u,c,0):[],p=null,m=null,h=null;if(!u)h=`The frequency axis contains a non-positive sample, so the sweep cannot be interpreted`;else if(d.length===0)h=`The response never crosses 0 dB, so no unity-gain frequency exists`;else if(d.length>1)h=`The response crosses 0 dB ${d.length} times, so the phase margin is ambiguous`;else{let e=d[0],t=smInterp(u,w,e.x);if(t==null)h=`No finite samples bracket the 0 dB crossing`;else if(smPassed(w,e.i,q))h=`The phase has already passed ${q} degrees below the 0 dB crossing, so the loop is unstable and a phase margin is not defined`;else{p=180+t-z;m=e.x}}let g=u?smCross(u,w,q):[],f=null,v=null,y=null;if(!u)y=h;else if(g.length===0)y=`The phase never reaches ${q} degrees, so the gain margin is undefined`;else if(g.length>1)y=`The phase reaches ${q} degrees ${g.length} times, so the gain margin is ambiguous`;else{let e=g[0],t=smInterp(u,c,e.x);if(t==null)y=`No finite samples bracket the ${q} degree crossing`;else{f=-t;v=e.x}}t.push(smRecord(n,e,i,`phase-margin`,`Phase margin`,`deg`,p,h,m),smRecord(n,e,i,`gain-margin`,`Gain margin`,`dB`,f,y,v))}}),t}
function smRecord(e,t,n,r,i,a,o,s,c){let l=o!=null&&Number.isFinite(o);let u={id:`${e}:${n.id}:${r}`,analysisIndex:e,analysis:t.analysis,plotName:t.plotName,outputId:n.id,outputLabel:n.label,metric:r,label:i,unit:a,origin:`automatic`};if(!l)return{...u,status:`unavailable`,reason:s};return{...u,status:`available`,value:o,...(c!=null&&Number.isFinite(c)?{evidence:{kind:`point`,coordinate:Math.pow(10,c)}}:{})}}
