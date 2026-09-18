import{t as e}from"./rolldown-runtime-CbXtAM7H.js";
const REACT_ELEMENT_TYPE=Symbol.for(`react.transitional.element`);
const REACT_FRAGMENT_TYPE=Symbol.for(`react.fragment`);
function jsxDEV(type,config,maybeKey){
  let key=null;
  let ref=void 0;
  const props={};
  if(maybeKey!==void 0&&maybeKey!==null)key=``+maybeKey;
  if(config!=null){
    for(const propName in config){
      if(!Object.prototype.hasOwnProperty.call(config,propName))continue;
      if(propName===`key`){
        if(key===null&&config.key!=null)key=``+config.key;
        continue;
      }
      if(propName===`ref`){ref=config.ref;continue}
      props[propName]=config[propName];
    }
  }
  return{$$typeof:REACT_ELEMENT_TYPE,type,key,ref,props};
}
var t=e((e=>{e.Fragment=REACT_FRAGMENT_TYPE,e.jsxDEV=jsxDEV})),n=e(((e,n)=>{n.exports=t()}));export{n as t};
