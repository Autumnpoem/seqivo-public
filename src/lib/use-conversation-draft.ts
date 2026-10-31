import {useRef,useState} from 'react';
import {readConversationDraft,saveConversationDraft,removeSubmittedConversationDraft,type ConversationDraft} from '../conversation-drafts';

export interface ConversationDraftSnapshot {key:string|null;value:ConversationDraft}

export function useConversationDraft(key:string|null){
  const [storage]=useState(()=>{try{return window.localStorage;}catch{return null;}});
  const read=(scope:string|null)=>({key:scope,value:storage?readConversationDraft(storage,scope):{title:'',message:''},saved:Boolean(storage&&scope)});
  const [state,setState]=useState(()=>read(key));
  // Reset the visible value together with its scope, before children render.
  // Only explicit edits write storage; visiting another task cannot overwrite it.
  const current=state.key===key?state:read(key);
  if(state.key!==key)setState(current);
  const latest=useRef(current);latest.current=current;
  function update(patch:Partial<ConversationDraft>){
    const next={key,value:{...latest.current.value,...patch},saved:false};
    next.saved=Boolean(storage&&saveConversationDraft(storage,key,next.value));
    latest.current=next;setState(next);
  }
  function capture():ConversationDraftSnapshot{return {key,value:{...latest.current.value}};}
  function clearSubmitted(snapshot:ConversationDraftSnapshot){
    if(storage&&!removeSubmittedConversationDraft(storage,snapshot.key,snapshot.value))return;
    const fresh=latest.current;
    if(fresh.key===snapshot.key&&fresh.value.title===snapshot.value.title&&fresh.value.message===snapshot.value.message){
      const next={...fresh,value:{title:'',message:''},saved:Boolean(storage&&snapshot.key)};
      latest.current=next;setState(next);
    }
  }
  return {value:current.value,saved:current.saved,update,capture,clearSubmitted};
}
