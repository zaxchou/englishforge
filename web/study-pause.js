(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.StudyPause=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const DAY=86400000,SHANGHAI=8*3600000;
  const EMPTY=Object.freeze({revision:0,windows:Object.freeze([])});
  const paused=state=>state?.windows?.at(-1)?.end===null;
  const calendarDay=at=>Math.floor((at+SHANGHAI)/DAY)*DAY;
  const dateValue=date=>Date.parse(date+'T00:00:00Z');
  function skipped(state,anchor,now,toTime){
    let total=0;
    for(const {start,end} of state?.windows||[]){
      const from=Math.max(anchor,toTime(start)),until=Math.min(now,end===null?now:toTime(end));
      if(until>from)total+=until-from;
    }
    return total;
  }
  // Stored deadlines stay anchored to real practice. Add back only paused time since that practice.
  function projectDue(state,due,anchor,now){
    if(!Number.isFinite(due)||due<=0||!state?.windows?.length)return due;
    const since=Number.isFinite(anchor)&&anchor>0?anchor:Math.min(due,state.windows[0].start);
    return due+skipped(state,since,now,t=>t);
  }
  function projectDay(state,due,anchor,today){
    if(!state?.windows?.length)return due;
    const date=dateValue(due),since=dateValue(anchor),now=dateValue(today);
    if(!Number.isFinite(date)||!Number.isFinite(since)||!Number.isFinite(now))return due;
    return new Date(date+skipped(state,since,now,calendarDay)).toISOString().slice(0,10);
  }
  function transition(state,shouldPause,now){
    state=state||EMPTY;
    if(paused(state)===shouldPause)return state;
    const windows=[...state.windows];
    const last=windows.at(-1);
    const at=Math.max(now,last?.end??last?.start??0);
    if(shouldPause)windows.push({start:at,end:null});
    else windows[windows.length-1]={start:last.start,end:at};
    return {revision:state.revision+1,windows};
  }
  return {EMPTY,paused,projectDue,projectDay,transition};
});
