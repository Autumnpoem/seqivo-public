import {useLayoutEffect} from 'react';

// Inner panels consume the request before the App changes pages.
export function useNativeBack(handle:()=>boolean,capture=false){
  useLayoutEffect(()=>{
    const back=(event:Event)=>{
      if(!event.defaultPrevented&&handle())event.preventDefault();
    };
    window.addEventListener('seqivo:native-back',back,capture);
    return()=>window.removeEventListener('seqivo:native-back',back,capture);
  },[handle,capture]);
}
