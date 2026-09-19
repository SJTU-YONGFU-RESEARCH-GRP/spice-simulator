import{t as e}from"./rolldown-runtime-CbXtAM7H.js";
const REACT_ELEMENT_TYPE=Symbol.for(`react.transitional.element`);
const REACT_FRAGMENT_TYPE=Symbol.for(`react.fragment`);
function jsxDEV(type,config,maybeKey){
  // PATCH(A3 2026-09-19): match React 19 production `jsx` semantics.
  // The original shim moved `ref` out of props onto the element, but react-dom
  // coerceRef reads ONLY element.props.ref -> every JSX ref resolved to null.
  // Here `ref` stays in props (canonical) and is mirrored on the element.
  null==config&&(config={});
  let key=null;
  maybeKey!==void 0&&(key=``+maybeKey);
  config.key!==void 0&&(key=``+config.key);
  let props;
  if(`key` in config){
    props={};
    for(const propName in config){
      if(propName===`key`)continue;
      props[propName]=config[propName];
    }
  }else props=config;
  const ref=props.ref;
  return{$$typeof:REACT_ELEMENT_TYPE,type,key,ref:ref!==void 0?ref:null,props};
}
var t=e((e=>{e.Fragment=REACT_FRAGMENT_TYPE,e.jsxDEV=jsxDEV})),n=e(((e,n)=>{n.exports=t()}));export{n as t};
