// Time-estimate / SPICE / ASET workspace extracted from app.js.
// The feature code is intentionally kept structurally identical. App-owned
// geometry/data helpers are injected at startup to avoid duplicating state.

export function createScriptWorkspace(deps){
  const {
    $,
    add,
    buildResolutionLattice,
    calculateSingleCrystal,
    checkedValue,
    clamp,
    cross,
    currentInstrument,
    dot,
    effectiveS2MaxAtEi,
    hklToQ,
    tasConvention,
    norm,
    num,
    parseNumericValue,
    qeDarkBlockWarningsForHKLE,
    rad2deg,
    renderGeometry,
    resizeVisiblePlots,
    safeResizePlot,
    scale,
    userFacingTasMessage,
  }=deps;

  // ==================== Time estimate ====================
  let timeScanRowCounter=0;
  let timeScanSelectionAnchor=null;
  let timeScanDragState=null;
  let timeLoopPairCounter=0;
  const TIME_ESTIMATE_STORAGE_KEY='tas-simulator-time-estimate-v1';
  let restoringTimeEstimate=false;

  function setGeometryCardTab(name){
    const time=name==='time';
    $('geometryTabAngles')?.classList.toggle('active',!time);
    $('geometryTabTime')?.classList.toggle('active',time);
    $('geometryTabAngles')?.setAttribute('aria-selected',String(!time));
    $('geometryTabTime')?.setAttribute('aria-selected',String(time));
    $('geometryAnglesPane')?.classList.toggle('hidden',time);
    $('geometryTimePane')?.classList.toggle('hidden',!time);
    $('singleMain')?.querySelector('.chart-grid')?.classList.toggle('time-estimate-active',time);
    saveTimeEstimateState();
    if(time && $('timeScanRows')?.children.length){
      requestAnimationFrame(()=>validateAllTimeScanRows({showMessage:true}));
    }
    // Both tabs share the same card width. Resize Plotly after switching panes
    // so it follows any responsive layout change without changing column widths.
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const powder=checkedValue('sampleMode')==='powder';
      safeResizePlot($(powder?'powderPlot':'singlePlot'));
      if(!time && (powder ? deps.powderCache : deps.singleCache)){
        // Rebuild the newly visible TAS geometry after layout has settled.
        // This covers both Single and Scan geometry panes.
        if(powder) renderGeometry(deps.powderCache,0);
        else renderGeometry(deps.singleCache,Number($('hwSlider')?.value)||0);
      }
      if(time){
        updateTimeScanScrollState();
      }
    }));
  }

  function currentGeometryCardTab(){
    return $('geometryTabTime')?.classList.contains('active') ? 'time' : 'angles';
  }

  function timeEstimateStoredState(){
    const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')]
      .map(timeScanRowValues).filter(Boolean);
    const fields={};
    for(const prefix of ['Start','End']){
      const ids=timeEstimateDatePartIds(prefix);
      fields[prefix.toLowerCase()]={
        date:$(ids.date)?.value||'',
        hour:$(ids.hour)?.value||'',
        minute:$(ids.minute)?.value||''
      };
    }
    return {version:5,tab:currentGeometryCardTab(),rows,fields,settings:{
      mcuSecondsPerUnit:String($('timeMcuSecondsPerUnit')?.value||'1'),
      movementPercent:String($('timeMovementPercent')?.value||'1')
    }};
  }

  function saveTimeEstimateState(){
    if(restoringTimeEstimate) return;
    try{ localStorage.setItem(TIME_ESTIMATE_STORAGE_KEY,JSON.stringify(timeEstimateStoredState())); }
    catch(_e){ /* localStorage can be unavailable in restricted browser contexts. */ }
  }

  function restoreTimeEstimateState(){
    let saved;
    try{ saved=JSON.parse(localStorage.getItem(TIME_ESTIMATE_STORAGE_KEY)||'null'); }
    catch(_e){ return false; }
    if(!saved || ![1,2,3,4,5].includes(saved.version) || !Array.isArray(saved.rows)) return false;
    restoringTimeEstimate=true;
    try{
      const host=$('timeScanRows');
      if(host) host.replaceChildren();
      timeScanRowCounter=0;
      timeLoopPairCounter=0;
      for(const values of saved.rows) addTimeScanRow(values||{},{suppressAutoPair:true});
      ensureTimeLoopPairIds();
      if(!saved.rows.length) addTimeScanRow({variable:'s1'});
      for(const prefix of ['Start','End']){
        const ids=timeEstimateDatePartIds(prefix);
        const values=saved.fields?.[prefix.toLowerCase()]||{};
        if($(ids.date)) $(ids.date).value=String(values.date||'');
        if($(ids.hour)) $(ids.hour).value=String(values.hour||'');
        if($(ids.minute)) $(ids.minute).value=String(values.minute||'');
      }
      if($('timeMcuSecondsPerUnit')) $('timeMcuSecondsPerUnit').value=String(saved.settings?.mcuSecondsPerUnit||'1');
      if($('timeMovementPercent')) $('timeMovementPercent').value=String(saved.settings?.movementPercent??'1');
      setGeometryCardTab(saved.tab==='time'?'time':'angles');
      updateTimeScanScrollState();
      updateTimeFixHeaderState();
      return true;
    }finally{ restoringTimeEstimate=false; }
  }

  function setTimeScanRowWarning(row,warning){
    if(!row) return;
    row.classList.toggle('time-scan-warning',!!warning);
    const index=row.querySelector('[data-time-index]');
    if(index) index.setAttribute('aria-invalid',warning?'true':'false');
  }

  function clearTimeScanRowWarnings(){
    document.querySelectorAll('#timeScanRows .time-scan-row').forEach(row=>{
      setTimeScanRowWarning(row,false);
      row.classList.remove('time-s2-limit-warning');
      delete row.dataset.timeS2Warning;
    });
  }

  function setTimeScanS2LimitWarning(row,warning,message=''){
    if(!row) return;
    row.classList.toggle('time-s2-limit-warning',!!warning);
    if(warning && message) row.dataset.timeS2Warning=message;
    else delete row.dataset.timeS2Warning;
  }

  function timeHklValueAt(parsed,index){
    if(parsed.fixed) return parsed.value;
    const direction=parsed.final>=parsed.initial ? 1 : -1;
    return parsed.initial + direction*parsed.step*index;
  }

  function hklInCurrentScatteringPlane(hkl){
    try{
      const {rl}=buildResolutionLattice();
      const U=[num('Uh'),num('Uk'),num('Ul')], V=[num('Vh'),num('Vk'),num('Vl')];
      const qU=hklToQ(rl,U), qV=hklToQ(rl,V), q=hklToQ(rl,hkl);
      const normal=cross(qU,qV), nn=norm(normal), qn=norm(q);
      if(!(nn>1e-12)) return {ok:false,error:'Current U and V do not define a valid scattering plane.'};
      if(qn<=1e-12) return {ok:true};
      const relative=Math.abs(dot(normal,q))/(nn*qn);
      return {ok:relative<=1e-8,relative};
    }catch(err){
      return {ok:false,error:userFacingTasMessage(err?.message||String(err))};
    }
  }

  function setScatteringPlaneWarning(boxId,message){
    const box=$(boxId);
    if(!box) return;
    const text=String(message||'').trim();
    box.textContent=text;
    box.classList.toggle('hidden',!text);
  }

  function scatteringPlaneWarningMessage(hkl,label='HKL'){
    const result=hklInCurrentScatteringPlane(hkl);
    if(result.ok) return '';
    if(result.error) return `Warning: ${result.error}`;
    return `Warning: ${label} (${hkl.map(v=>Number(v).toFixed(3)).join(', ')}) is outside the current U-V scattering plane.`;
  }

  function validateHkleScanPlane(parsedByKey,points){
    const last=Math.max(0,points-1);
    for(const i of [...new Set([0,last])]){
      const hkl=['h','k','l'].map(key=>timeHklValueAt(parsedByKey[key],i));
      const result=hklInCurrentScatteringPlane(hkl);
      if(!result.ok) return {ok:false,hkl,error:result.error};
    }
    return {ok:true};
  }

  function timeCommandMeta(command){
    const c=String(command||'s1');
    if(c==='qe') return {kind:'scan',specs:[{key:'q',label:'Q'},{key:'hw',label:'ħω'}]};
    if(c==='hkle') return {kind:'scan',specs:[{key:'h',label:'H'},{key:'k',label:'K'},{key:'l',label:'L'},{key:'hw',label:'ħω'}]};
    if(c==='br') return {kind:'drive',specs:[{key:'hkl',label:'HKL'}]};
    if(c==='s1') return {kind:'scan',specs:[{key:'s1',label:'S1'}]};
    if(c==='s2') return {kind:'scan',specs:[{key:'s2',label:'S2'}]};
    if(c==='rels1') return {kind:'scan',specs:[{key:'s1',label:'rel S1'}]};
    if(c==='rels2') return {kind:'scan',specs:[{key:'s2',label:'rel S2'}]};
    if(c==='th2th') return {kind:'scan',specs:[{key:'th2th',label:'th2th'}]};
    if(c==='temp') return {kind:'drive',specs:[{key:'target',label:'Target'}]};
    if(c==='field') return {kind:'drive',specs:[{key:'target',label:'Target'}]};
    if(c==='wait') return {kind:'wait',specs:[]};
    if(c==='loop') return {kind:'loop',specs:[{key:'loop',label:'Loop'}]};
    if(c==='endloop') return {kind:'endloop',specs:[]};
    return {kind:'scan',specs:[{key:'s1',label:'S1'}]};
  }

  function timeRangeSpec(command){
    return timeCommandMeta(command).specs;
  }

  function timeCommandIsScan(command){ return timeCommandMeta(command).kind==='scan'; }
  function timeCommandIsDrive(command){ return timeCommandMeta(command).kind==='drive'; }
  function timeCommandIsWait(command){ return timeCommandMeta(command).kind==='wait'; }
  function timeCommandIsLoop(command){ return timeCommandMeta(command).kind==='loop'; }
  function timeCommandIsEndLoop(command){ return timeCommandMeta(command).kind==='endloop'; }

  function setTimeInputInvalid(input,invalid){
    if(!input) return;
    input.classList.toggle('time-invalid-number',!!invalid);
    input.setAttribute('aria-invalid',invalid?'true':'false');
  }

  function timeRangeInputHtml(spec,value='',command='s1'){
    const meta=timeCommandMeta(command);
    const kind=meta.kind;
    let placeholder='target value or loopN';
    if(meta.target==='br') placeholder='H K L (e.g. 1 0 0)';
    else if(kind==='scantitle') placeholder='e.g. T=loop1';
    else if(kind==='scan') placeholder='fixed, loopN, or initial final step';
    else if(kind==='loop') placeholder='initial final step';
    return `<label class="time-range-field"><span class="time-range-label">${spec.label}</span><input type="text" inputmode="text" data-time-range-key="${spec.key}" value="${String(value??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')}" placeholder="${placeholder}"></label>`;
  }

  function updateTimeCommandTimeCell(row){
    if(!row) return;
    const command=row.querySelector('[data-time-variable]')?.value || 's1';
    const kind=timeCommandMeta(command).kind;
    const timeInput=row.querySelector('[data-time-mcu]');
    const fix=row.querySelector('[data-time-fix]');
    const detailInputs=[...row.querySelectorAll('[data-time-range-key]')];
    const parsedDetails=detailInputs.map(input=>parseTimeDetail(input.value,command,row));
    const allDetailsValid=parsedDetails.length>0 && parsedDetails.every(parsed=>parsed.ok);
    const allDetailsFixed=allDetailsValid && parsedDetails.every(parsed=>parsed.fixed);
    const structural=(kind==='loop' || kind==='endloop');
    const automaticZero=structural || kind==='scantitle' || (kind==='drive') || (kind==='scan' && allDetailsFixed);

    if(timeInput){
      if(automaticZero){
        timeInput.value='0';
        timeInput.readOnly=true;
        timeInput.classList.add('time-readonly');
        setTimeInputInvalid(timeInput,false);
        timeInput.title='Detail is fixed, so MCU is automatically 0.';
      }else{
        timeInput.readOnly=false;
        timeInput.classList.remove('time-readonly');
        timeInput.title=kind==='wait' ? 'Wait duration (seconds)' : (kind==='count' ? 'Count preset in MCU' : 'MCU per scan point (whole number)');
      }
    }

    if(fix){
      const forced=(kind!=='scan') || automaticZero;
      if(forced){
        if(row.dataset.timeFixBeforeForced===undefined) row.dataset.timeFixBeforeForced=fix.checked?'1':'0';
        fix.checked=true;
        fix.disabled=true;
      }else{
        fix.disabled=false;
        if(row.dataset.timeFixBeforeForced!==undefined){
          fix.checked=row.dataset.timeFixBeforeForced==='1';
          delete row.dataset.timeFixBeforeForced;
        }
      }
      if(kind==='wait') fix.title='Wait time is excluded from Calc MCU.';
      else if(kind==='scantitle') fix.title='scantitle is excluded from Calc MCU.';
      else if(structural) fix.title='Loop structure uses MCU = 0 and is excluded from Calc MCU.';
      else if(automaticZero) fix.title='Fixed Detail automatically uses MCU = 0 and is excluded from Calc MCU.';
      else if(kind==='drive') fix.title='Drive command time is fixed and excluded from Calc MCU.';
      else fix.title='Keep this scan MCU fixed during Calc MCU.';
    }
  }

  function updateTimeScanRowFields(row,values={}){
    if(!row) return;
    const command=row.querySelector('[data-time-variable]')?.value || 's1';
    const host=row.querySelector('[data-time-range-host]');
    if(!host) return;
    const previous={};
    for(const input of host.querySelectorAll('[data-time-range-key]')) previous[input.dataset.timeRangeKey]=input.value;
    const spec=timeRangeSpec(command);
    host.style.setProperty('--time-range-cols',String(spec.length));
    host.innerHTML=spec.map(item=>timeRangeInputHtml(item,values[item.key] ?? previous[item.key] ?? '',command)).join('');
    host.querySelectorAll('input').forEach(input=>{
      input.addEventListener('input',()=>{
        delete input.dataset.timeLoopRefBroken;
        delete input.dataset.timeLoopRefPair;
        const parsed=validateTimeRangeInput(input);
        saveTimeEstimateState();
        if(parsed.ok) clearTimeEstimateMessage();
        else setTimeEstimateMessage(parsed.error,true);
      });
      input.addEventListener('change',()=>{
        const parsed=validateTimeRangeInput(input);
        if(parsed.ok) applyRangeToSelectedTimeScans(row,input);
        updateTimeCommandTimeCell(row);
        saveTimeEstimateState();
        validateAllTimeScanRows({showMessage:true});
      });
    });
    updateTimeCommandTimeCell(row);
    updateTimeLoopIndentation();
  }

  function timeScanRows(){
    return [...document.querySelectorAll('#timeScanRows .time-scan-row')];
  }

  function selectedTimeScanRows(){
    return timeScanRows().filter(row=>row.classList.contains('time-scan-selected'));
  }

  function analyzeTimeLoopStructure(){
    const rows=timeScanRows();
    const stack=[];
    const info=new Map();
    const pairs=[];
    const unmatchedEnd=[];
    for(const row of rows){
      const command=row.querySelector('[data-time-variable]')?.value || 's1';
      if(command==='loop'){
        const level=stack.length+1;
        const entry={row,level,parentLoops:stack.map(x=>x.row)};
        info.set(row,{kind:'loop',level,depth:level-1,parentLoops:entry.parentLoops,pairRow:null});
        stack.push(entry);
        continue;
      }
      if(command==='endloop'){
        const opened=stack.pop();
        if(opened){
          const loopInfo=info.get(opened.row);
          loopInfo.pairRow=row;
          info.set(row,{kind:'endloop',level:opened.level,depth:opened.level-1,parentLoops:stack.map(x=>x.row),pairRow:opened.row});
          pairs.push({loopRow:opened.row,endRow:row,level:opened.level});
        }else{
          info.set(row,{kind:'endloop',level:0,depth:0,parentLoops:[],pairRow:null});
          unmatchedEnd.push(row);
        }
        continue;
      }
      info.set(row,{kind:'command',level:0,depth:stack.length,parentLoops:stack.map(x=>x.row),pairRow:null});
    }
    return {rows,info,pairs,unmatchedLoops:stack.map(x=>x.row),unmatchedEnd};
  }

  function ensureTimeLoopPairIds(){
    const structure=analyzeTimeLoopStructure();
    for(const {loopRow,endRow} of structure.pairs){
      let pair=loopRow.dataset.timeLoopPair || endRow.dataset.timeLoopPair || '';
      if(!pair) pair=`lp${++timeLoopPairCounter}`;
      loopRow.dataset.timeLoopPair=pair;
      endRow.dataset.timeLoopPair=pair;
    }
    return structure;
  }

  function matchingTimeLoopRow(row){
    if(!row) return null;
    const pair=row.dataset.timeLoopPair;
    if(pair){
      return timeScanRows().find(candidate=>candidate!==row && candidate.dataset.timeLoopPair===pair) || null;
    }
    const structure=ensureTimeLoopPairIds();
    return structure.info.get(row)?.pairRow || null;
  }

  function timeLoopLevelForRow(row){
    return analyzeTimeLoopStructure().info.get(row)?.level || 0;
  }

  function updateTimeLoopCommandLabels(){
    const structure=ensureTimeLoopPairIds();
    for(const row of structure.rows){
      const select=row.querySelector('[data-time-variable]');
      if(!select) continue;
      const rowInfo=structure.info.get(row);
      const loopOption=[...select.options].find(option=>option.value==='loop');
      const endOption=[...select.options].find(option=>option.value==='endloop');
      const proposedLevel=(select.value==='loop' && rowInfo?.level) ? rowInfo.level : Math.max(1,(rowInfo?.depth||0)+1);
      if(loopOption) loopOption.textContent=`loop${proposedLevel}`;
      if(endOption){
        endOption.textContent=(select.value==='endloop' && rowInfo?.level) ? `endloop${rowInfo.level}` : 'endloop';
        endOption.disabled=select.value!=='endloop';
        endOption.hidden=select.value!=='endloop';
      }
      select.disabled=select.value==='endloop';
      select.title=select.value==='endloop' ? 'This endloop is paired automatically with its loop command.' : '';
    }
    return structure;
  }

  function updateTimeLoopIndentation(){
    const structure=updateTimeLoopCommandLabels();
    for(const row of structure.rows){
      const rowInfo=structure.info.get(row);
      const depth=Math.max(0,rowInfo?.depth||0);
      row.style.setProperty('--time-loop-depth',String(depth));
      row.dataset.timeLoopDepth=String(depth);
      row.dataset.timeLoopLevel=String(rowInfo?.level||0);
      const commandCell=row.querySelector('.time-command-cell');
      if(commandCell) commandCell.style.paddingLeft=`${5+depth*14}px`;
    }
  }

  function parseTimeLoopReferenceToken(raw,row){
    const token=String(raw??'').trim();
    const match=/^loop([1-9]\d*)$/i.exec(token);
    if(!match) return null;
    const level=Number(match[1]);
    const rowInfo=ensureTimeLoopPairIds().info.get(row);
    const enclosing=rowInfo?.parentLoops||[];
    const loopRow=enclosing[level-1] || null;
    if(!loopRow) return {ok:false,error:`${token} is not available at this command.`,loopRef:level};
    return {ok:true,fixed:true,count:1,value:null,symbolic:true,loopRef:level,loopRow};
  }

  function normalizeBoundTimeLoopReferences(){
    const structure=ensureTimeLoopPairIds();
    for(const input of document.querySelectorAll('#timeScanRows [data-time-range-key]')){
      const commandRow=input.closest('.time-scan-row');
      if(input.dataset.timeLoopTextPairs){
        let refs=[];
        try{ refs=JSON.parse(input.dataset.timeLoopTextPairs)||[]; }catch(_e){ refs=[]; }
        let occurrence=0,broken=false;
        const commandInfo=structure.info.get(commandRow);
        input.value=String(input.value||'').replace(/\bloop([1-9]\d*)\b/gi,token=>{
          const ref=refs[occurrence++];
          if(!ref){ broken=true; return token; }
          const loopRow=structure.rows.find(row=>row.dataset.timeLoopPair===ref.pair && row.querySelector('[data-time-variable]')?.value==='loop');
          const loopInfo=loopRow ? structure.info.get(loopRow) : null;
          const stillEnclosing=!!(loopRow && commandInfo?.parentLoops?.includes(loopRow));
          if(stillEnclosing && loopInfo?.level) return `loop${loopInfo.level}`;
          broken=true; return token;
        });
        if(occurrence!==refs.length) broken=true;
        if(broken) input.dataset.timeLoopRefBroken='1';
        else delete input.dataset.timeLoopRefBroken;
        continue;
      }
      if(input.dataset.timeLoopRefPairs){
        let refs=[];
        try{ refs=JSON.parse(input.dataset.timeLoopRefPairs)||[]; }catch(_e){ refs=[]; }
        const tokens=String(input.value||'').trim().split(/\s+/).filter(Boolean);
        let broken=false;
        for(const ref of refs){
          const loopRow=structure.rows.find(row=>row.dataset.timeLoopPair===ref.pair && row.querySelector('[data-time-variable]')?.value==='loop');
          const commandInfo=structure.info.get(commandRow);
          const loopInfo=loopRow ? structure.info.get(loopRow) : null;
          const stillEnclosing=!!(loopRow && commandInfo?.parentLoops?.includes(loopRow));
          if(stillEnclosing && loopInfo?.level && Number.isInteger(ref.tokenIndex) && ref.tokenIndex>=0 && ref.tokenIndex<tokens.length){
            tokens[ref.tokenIndex]=`loop${loopInfo.level}`;
          }else broken=true;
        }
        if(tokens.length) input.value=tokens.join(' ');
        if(broken) input.dataset.timeLoopRefBroken='1';
        else delete input.dataset.timeLoopRefBroken;
        continue;
      }
      const pair=input.dataset.timeLoopRefPair;
      if(!pair) continue;
      const loopRow=structure.rows.find(row=>row.dataset.timeLoopPair===pair && row.querySelector('[data-time-variable]')?.value==='loop');
      const commandInfo=structure.info.get(commandRow);
      const loopInfo=loopRow ? structure.info.get(loopRow) : null;
      const stillEnclosing=!!(loopRow && commandInfo?.parentLoops?.includes(loopRow));
      if(stillEnclosing && loopInfo?.level){
        input.value=`loop${loopInfo.level}`;
        delete input.dataset.timeLoopRefBroken;
      }else{
        input.dataset.timeLoopRefBroken='1';
      }
    }
  }

  function applyRangeToSelectedTimeScans(sourceRow,sourceInput){
    if(!sourceRow?.classList.contains('time-scan-selected') || !sourceInput) return;
    const selected=selectedTimeScanRows();
    if(selected.length<2) return;
    const variable=sourceRow.querySelector('[data-time-variable]')?.value || '';
    const key=sourceInput.dataset.timeRangeKey;
    if(!key) return;
    const value=sourceInput.value;
    for(const row of selected){
      if((row.querySelector('[data-time-variable]')?.value || '')!==variable) continue;
      const input=row.querySelector(`[data-time-range-key="${key}"]`);
      if(!input || input===sourceInput) continue;
      input.value=value;
      validateTimeRangeInput(input);
      updateTimeCommandTimeCell(row);
    }
  }

  function applyMcuToSelectedTimeScans(sourceRow,value){
    if(!sourceRow?.classList.contains('time-scan-selected')) return;
    const selected=selectedTimeScanRows();
    if(selected.length<2) return;
    for(const row of selected){
      const input=row.querySelector('[data-time-mcu]');
      if(!input || input.readOnly) continue;
      input.value=value;
      setTimeInputInvalid(input,false);
    }
  }

  function updateTimeFixHeaderState(){
    const header=$('timeFixAll');
    const selected=selectedTimeScanRows();
    if(header){
      const base=selected.length ? selected : timeScanRows();
      const targets=base.filter(row=>!row.querySelector('[data-time-fix]')?.disabled);
      const states=targets.map(row=>!!row.querySelector('[data-time-fix]')?.checked);
      header.disabled=!targets.length;
      header.checked=states.length>0 && states.every(Boolean);
      header.indeterminate=states.some(Boolean) && !states.every(Boolean);
      header.title=selected.length ? `Apply Fix to selected scan commands` : 'Apply Fix to all scan commands';
    }
    const remove=$('timeRemoveScan');
    if(remove){
      remove.disabled=selected.length===0;
      remove.title=selected.length ? `Remove ${selected.length} selected command${selected.length===1?'':'s'}` : 'Select one or more indices to remove';
    }
  }

  function clearTimeScanSelection(){
    for(const row of timeScanRows()) row.classList.remove('time-scan-selected');
    timeScanSelectionAnchor=null;
    updateTimeFixHeaderState();
  }

  function selectTimeScanIndex(row,event){
    const rows=timeScanRows();
    const index=rows.indexOf(row);
    if(index<0) return;
    const anchorIndex=timeScanSelectionAnchor ? rows.indexOf(timeScanSelectionAnchor) : -1;
    if(event.shiftKey && anchorIndex>=0){
      for(const r of rows) r.classList.remove('time-scan-selected');
      const a=Math.min(anchorIndex,index), b=Math.max(anchorIndex,index);
      for(let i=a;i<=b;i++) rows[i].classList.add('time-scan-selected');
    }else if(event.ctrlKey || event.metaKey){
      row.classList.toggle('time-scan-selected');
      timeScanSelectionAnchor=row;
    }else{
      for(const r of rows) r.classList.remove('time-scan-selected');
      row.classList.add('time-scan-selected');
      timeScanSelectionAnchor=row;
    }
    updateTimeFixHeaderState();
  }

  function clearTimeScanDragMarkers(){
    for(const row of timeScanRows()) row.classList.remove('time-drag-before','time-drag-after','time-drag-source');
    document.querySelectorAll('#timeScanRows .time-loop-empty-dropzone, #timeScanRows .time-edge-dropzone').forEach(zone=>zone.classList.remove('time-drop-active'));
  }

  function startTimeScanDrag(row,event){
    if(!row || !event?.dataTransfer) return;
    ensureTimeLoopPairIds();
    if(!row.classList.contains('time-scan-selected')){
      for(const r of timeScanRows()) r.classList.remove('time-scan-selected');
      row.classList.add('time-scan-selected');
      timeScanSelectionAnchor=row;
      updateTimeFixHeaderState();
    }
    let rows=selectedTimeScanRows();
    if(!rows.length) return;

    const command=row.querySelector('[data-time-variable]')?.value || '';
    // Normal index dragging always reorders a complete loop block.  This keeps
    // nested loops freely movable as units (loop1 may contain loop2, and loop2
    // can still be moved before/after other commands without tearing its pair
    // apart).  Alt-drag retains the older boundary-resize gesture for users who
    // explicitly want to slide only loopN/endloopN.
    const boundaryDrag=rows.length===1 && (command==='loop' || command==='endloop') && !!event.altKey;
    if(boundaryDrag){
      rows=[row];
      timeScanDragState={
        rows,
        target:null,
        mode:null,
        boundary:true,
        boundaryType:command==='loop'?'start':'end',
        pairRow:matchingTimeLoopRow(row)
      };
    }else{
      rows=expandTimeRowsToLoopBlocks(rows);
      timeScanDragState={rows,target:null,after:false,boundary:false};
    }
    rows.forEach(r=>r.classList.add('time-drag-source'));
    document.querySelector('#geometryTimePane .time-scan-table-wrap')?.classList.add('time-dragging');
    refreshEmptyTimeLoopDropzones();
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('text/plain',rows.map(r=>r.dataset.timeScanId||'').join(','));
  }

  function updateTimeScanDragTarget(event){
    if(!timeScanDragState) return;

    const edgeZone=event.target.closest?.('.time-edge-dropzone');
    if(edgeZone){
      event.preventDefault();
      clearTimeScanDragMarkers();
      timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
      edgeZone.classList.add('time-drop-active');
      timeScanDragState.target=edgeZone;
      timeScanDragState.mode=edgeZone.dataset.timeEdge==='start'?'edge-start':'edge-end';
      if(event.dataTransfer) event.dataTransfer.dropEffect='move';
      return;
    }

    // A loop/endloop boundary drag is different from an ordinary command drag:
    // it slides just that boundary so commands can be included/excluded without
    // first creating a row inside the loop.
    if(timeScanDragState.boundary){
      const target=event.target.closest?.('.time-scan-row');
      if(!target || timeScanDragState.rows.includes(target)) return;
      event.preventDefault();
      const indexCell=target.querySelector('[data-time-index]');
      const rect=(indexCell||target).getBoundingClientRect();
      const mode=event.clientY>rect.top+rect.height/2 ? 'after' : 'before';
      clearTimeScanDragMarkers();
      timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
      target.classList.add(mode==='after'?'time-drag-after':'time-drag-before');
      timeScanDragState.target=target;
      timeScanDragState.mode=mode;
      if(event.dataTransfer) event.dataTransfer.dropEffect='move';
      return;
    }

    const emptyZone=event.target.closest?.('.time-loop-empty-dropzone');
    if(emptyZone){
      event.preventDefault();
      clearTimeScanDragMarkers();
      timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
      emptyZone.classList.add('time-drop-active');
      timeScanDragState.target=emptyZone;
      timeScanDragState.mode='empty-loop';
      if(event.dataTransfer) event.dataTransfer.dropEffect='move';
      return;
    }

    const target=event.target.closest?.('.time-scan-row');
    if(!target || timeScanDragState.rows.includes(target)) return;
    event.preventDefault();

    const command=target.querySelector('[data-time-variable]')?.value || '';
    let mode='before';
    if(command==='loop'){
      // Dropping on a loop boundary always means “put this inside the loop”.
      mode='inside-start';
    }else if(command==='endloop'){
      // Dropping on endloop means insert immediately before it (still inside).
      mode='inside-end';
    }else{
      const indexCell=target.querySelector('[data-time-index]');
      const rect=(indexCell||target).getBoundingClientRect();
      mode=event.clientY>rect.top+rect.height/2 ? 'after' : 'before';
    }

    clearTimeScanDragMarkers();
    timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
    target.classList.add((mode==='after' || mode==='inside-start')?'time-drag-after':'time-drag-before');
    timeScanDragState.target=target;
    timeScanDragState.mode=mode;
    if(event.dataTransfer) event.dataTransfer.dropEffect='move';
  }

  function timeLoopPairOrderIsValid(rows){
    const stack=[];
    for(const row of rows){
      const command=row.querySelector('[data-time-variable]')?.value || '';
      if(command==='loop'){
        const pair=row.dataset.timeLoopPair || '';
        if(!pair) return false;
        stack.push(pair);
      }else if(command==='endloop'){
        const pair=row.dataset.timeLoopPair || '';
        if(!pair || !stack.length || stack[stack.length-1]!==pair) return false;
        stack.pop();
      }
    }
    return stack.length===0;
  }

  function finishTimeLoopBoundaryDrop(event){
    const state=timeScanDragState;
    if(!state?.boundary) return false;
    event.preventDefault();
    const boundaryRow=state.rows?.[0] || null;
    const target=state.target;
    const mode=state.mode || 'before';
    if(!boundaryRow || !target || boundaryRow===target) return true;

    const all=timeScanRows();
    const remaining=all.filter(row=>row!==boundaryRow);
    let insertIndex;
    if(mode==='edge-start') insertIndex=0;
    else if(mode==='edge-end') insertIndex=remaining.length;
    else{
      const targetIndex=remaining.indexOf(target);
      if(targetIndex<0) return true;
      insertIndex=targetIndex+(mode==='after'?1:0);
    }
    const candidate=remaining.slice();
    candidate.splice(insertIndex,0,boundaryRow);

    if(!timeLoopPairOrderIsValid(candidate)){
      setTimeEstimateMessage('Loop boundary cannot cross its paired boundary or break nested-loop structure.',true);
      return true;
    }

    const host=$('timeScanRows');
    let reference=null;
    if(insertIndex<candidate.length-1) reference=candidate[insertIndex+1];
    host.insertBefore(boundaryRow,reference);
    selectOnlyTimeScanRow(boundaryRow);
    ensureTimeLoopPairIds();
    renumberTimeScanRows();
    normalizeBoundTimeLoopReferences();
    refreshEmptyTimeLoopDropzones();
    saveTimeEstimateState();
    validateAllTimeScanRows({showMessage:true});
    return true;
  }

  function finishTimeScanDrop(event){
    if(!timeScanDragState) return;
    if(timeScanDragState.boundary){
      finishTimeLoopBoundaryDrop(event);
      clearTimeScanDragMarkers();
      document.querySelector('#geometryTimePane .time-scan-table-wrap')?.classList.remove('time-dragging');
      timeScanDragState=null;
      refreshEmptyTimeLoopDropzones();
      return;
    }
    event.preventDefault();
    const {rows,target}=timeScanDragState;
    const mode=timeScanDragState.mode || (timeScanDragState.after?'after':'before');
    if(target && !rows.includes(target)){
      const host=$('timeScanRows');
      let reference=target;

      if(mode==='edge-start'){
        reference=timeScanRows().find(row=>!rows.includes(row)) || null;
      }else if(mode==='edge-end'){
        reference=null;
      }else if(mode==='empty-loop'){
        const pair=target.dataset.timeLoopPair || '';
        reference=timeScanRows().find(row=>row.dataset.timeLoopPair===pair && row.querySelector('[data-time-variable]')?.value==='endloop') || null;
      }else if(mode==='after' || mode==='inside-start'){
        reference=target.nextSibling;
        // The immediate next sibling can itself be one of the dragged rows.
        // Skip dragged rows so the reference remains attached after they move.
        while(reference && rows.includes(reference)) reference=reference.nextSibling;
      }else if(mode==='inside-end' || mode==='before'){
        reference=target;
      }

      const fragment=document.createDocumentFragment();
      rows.forEach(row=>fragment.appendChild(row));
      host.insertBefore(fragment,reference);

      timeScanSelectionAnchor=rows[0]||null;
      ensureTimeLoopPairIds();
      renumberTimeScanRows();
      normalizeBoundTimeLoopReferences();
      refreshEmptyTimeLoopDropzones();
      saveTimeEstimateState();
      validateAllTimeScanRows({showMessage:true});
    }
    clearTimeScanDragMarkers();
    document.querySelector('#geometryTimePane .time-scan-table-wrap')?.classList.remove('time-dragging');
    timeScanDragState=null;
    refreshEmptyTimeLoopDropzones();
  }

  function cancelTimeScanDrag(){
    clearTimeScanDragMarkers();
    document.querySelector('#geometryTimePane .time-scan-table-wrap')?.classList.remove('time-dragging');
    timeScanDragState=null;
    refreshEmptyTimeLoopDropzones();
  }

  function applyTimeFixHeader(){
    const header=$('timeFixAll');
    if(!header) return;
    const selected=selectedTimeScanRows();
    const targets=selected.length ? selected : timeScanRows();
    for(const row of targets){
      const input=row.querySelector('[data-time-fix]');
      if(input && !input.disabled) input.checked=header.checked;
    }
    updateTimeFixHeaderState();
    saveTimeEstimateState();
  }

  function refreshEmptyTimeLoopDropzones(){
    const host=$('timeScanRows');
    if(!host) return;
    host.querySelectorAll('.time-loop-empty-dropzone,.time-edge-dropzone').forEach(zone=>zone.remove());

    const startZone=document.createElement('div');
    startZone.className='time-edge-dropzone'; startZone.dataset.timeEdge='start';
    startZone.title='Drop here to move selected command(s) before Index 1';
    host.insertBefore(startZone,host.firstChild);

    const structure=ensureTimeLoopPairIds();
    const rows=structure.rows;
    for(const loopRow of rows){
      if(loopRow.querySelector('[data-time-variable]')?.value!=='loop') continue;
      const endRow=matchingTimeLoopRow(loopRow);
      if(!endRow) continue;
      const startIndex=rows.indexOf(loopRow), endIndex=rows.indexOf(endRow);
      if(startIndex<0 || endIndex!==startIndex+1) continue; // only truly empty loops

      const zone=document.createElement('div');
      zone.className='time-loop-empty-dropzone';
      zone.dataset.timeLoopPair=loopRow.dataset.timeLoopPair||'';
      const level=Math.max(1,structure.info.get(loopRow)?.level||1);
      zone.dataset.timeLoopDepth=String(level);
      zone.style.setProperty('--time-empty-loop-depth',String(level-1));
      zone.title='Drop a command here to place it inside this loop';
      host.insertBefore(zone,endRow);
    }
    const endZone=document.createElement('div');
    endZone.className='time-edge-dropzone'; endZone.dataset.timeEdge='end';
    endZone.title='Drop here to move selected command(s) after the last Index';
    host.appendChild(endZone);
  }

  function updateTimeScanScrollState(){
    const wrap=document.querySelector('#geometryTimePane .time-scan-table-wrap');
    if(!wrap) return;
    // Keep the table geometry deterministic: show up to 10 scan rows, then scroll.
    // Do not derive this height from the Q-E plot or message/footer content.
    wrap.style.maxHeight='';
    wrap.classList.toggle('time-scan-scroll',timeScanRows().length>10);
  }

  function renumberTimeScanRows(){
    ensureTimeLoopPairIds();
    timeScanRows().forEach((row,i)=>{
      const cell=row.querySelector('[data-time-index]');
      if(cell) cell.textContent=String(i+1);
    });
    updateTimeLoopIndentation();
    normalizeBoundTimeLoopReferences();
    refreshEmptyTimeLoopDropzones();
    updateTimeScanScrollState();
    updateTimeFixHeaderState();
  }

  function formatTimeMcuValue(value){
    const n=parseNumericValue(value);
    return Number.isFinite(n) ? String(Math.floor(Math.max(0,n))) : String(value??'');
  }

  function addTimeScanRow(values={},options={}){
    const host=$('timeScanRows');
    if(!host) return null;
    const row=document.createElement('div');
    row.className='time-scan-row';
    row.dataset.timeScanId=String(++timeScanRowCounter);
    row.innerHTML=`
      <div class="time-scan-cell time-scan-index" data-time-index></div>
      <div class="time-scan-cell time-command-cell"><select data-time-variable aria-label="Command">
        <option value="s1">s1</option><option value="s2">s2</option><option value="rels1">rel s1</option><option value="rels2">rel s2</option><option value="th2th">th2th</option><option value="qe">QE</option><option value="hkle">HKLE</option><option value="br">br</option><option value="temp">temp</option><option value="field">field</option><option value="wait">wait</option><option value="loop">loop</option><option value="endloop">endloop</option>
      </select></div>
      <div class="time-scan-cell"><div class="time-range-inputs" data-time-range-host></div></div>
      <div class="time-scan-cell"><span class="time-mcu-entry"><input type="text" inputmode="numeric" data-time-mcu value="${String(values.mcu??values.time??((values.command??values.variable)==='wait' ? (values.ranges?.wait??values.details?.wait??'') : '')).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}" placeholder="0"></span></div>
      <div class="time-scan-cell time-fix-cell"><input type="checkbox" data-time-fix aria-label="Fix time for this command"></div>`;
    const before=options?.before;
    if(before && before.parentElement===host) host.insertBefore(row,before);
    else host.appendChild(row);
    const command=row.querySelector('[data-time-variable]');
    let requested=values.command ?? values.variable ?? 's1';
    let restoredRanges=values.ranges||values.details||{};
    // v40: br uses one compact HKL Detail field. Migrate both the pre-v39
    // target form and the v39 three-field H/K/L form without changing values.
    if(requested==='br'){
      if(restoredRanges.hkl===undefined){
        if(restoredRanges.h!==undefined || restoredRanges.k!==undefined || restoredRanges.l!==undefined){
          restoredRanges={hkl:[restoredRanges.h??'',restoredRanges.k??'',restoredRanges.l??''].join(' ').trim()};
        }else if(restoredRanges.target!==undefined){
          restoredRanges={hkl:String(restoredRanges.target??'').trim()};
        }
      }
    }
    const allowed=['s1','s2','rels1','rels2','th2th','qe','hkle','br','temp','field','wait','loop','endloop'];
    command.value=allowed.includes(requested)?requested:'s1';
    const fix=row.querySelector('[data-time-fix]');
    if(fix) fix.checked=!!values.fixed;
    const initialTime=row.querySelector('[data-time-mcu]');
    if(initialTime && String(initialTime.value).trim()!=='' && Number.isFinite(parseNumericValue(initialTime.value))) initialTime.value=formatTimeMcuValue(initialTime.value);
    updateTimeScanRowFields(row,restoredRanges);
    row.dataset.timeCommand=command.value;
    if(command.value==='loop' && !options?.suppressAutoPair){
      const endRow=addTimeScanRow({command:'endloop'},{before:row.nextElementSibling,suppressAutoPair:true});
      const pair=`lp${++timeLoopPairCounter}`;
      row.dataset.timeLoopPair=pair;
      if(endRow) endRow.dataset.timeLoopPair=pair;
    }
    if(command.value==='endloop') command.disabled=true;
    command.addEventListener('change',()=>{
      const previous=row.dataset.timeCommand || 's1';
      const next=command.value;
      const previousPair=previous==='loop' ? matchingTimeLoopRow(row) : null;
      if(previous==='loop' && next!=='loop' && previousPair){
        previousPair.remove();
        delete row.dataset.timeLoopPair;
      }
      row.dataset.timeCommand=next;
      updateTimeScanRowFields(row);
      if(previous!=='loop' && next==='loop'){
        const endRow=addTimeScanRow({command:'endloop'},{before:row.nextElementSibling,suppressAutoPair:true});
        const pair=`lp${++timeLoopPairCounter}`;
        row.dataset.timeLoopPair=pair;
        if(endRow) endRow.dataset.timeLoopPair=pair;
        // A newly-created loop immediately becomes the active insertion context.
        // The very first + Add scan therefore goes inside this loop, even while empty.
        selectOnlyTimeScanRow(row);
      }
      renumberTimeScanRows();
      clearTimeEstimateMessage();
      updateTimeFixHeaderState();
      saveTimeEstimateState();
      validateAllTimeScanRows({showMessage:true});
    });
    const timeInput=row.querySelector('[data-time-mcu]');
    timeInput.addEventListener('input',()=>{
      if(timeInput.readOnly) return;
      const parsed=validateTimeMcuInput(timeInput);
      saveTimeEstimateState();
      if(parsed.ok) clearTimeEstimateMessage();
      else setTimeEstimateMessage('MCU must be a non-negative whole number (wait uses seconds).',true);
    });
    timeInput.addEventListener('change',()=>{
      if(timeInput.readOnly) return;
      const parsed=validateTimeMcuInput(timeInput);
      if(parsed.ok){
        timeInput.value=formatTimeMcuValue(parsed.value);
        applyMcuToSelectedTimeScans(row,timeInput.value);
      }
      saveTimeEstimateState();
      validateAllTimeScanRows({showMessage:true});
    });
    fix?.addEventListener('change',()=>{ updateTimeFixHeaderState(); saveTimeEstimateState(); });
    const indexCell=row.querySelector('[data-time-index]');
    if(indexCell){
      indexCell.draggable=true;
      indexCell.title='Click to select; drag to reorder. Loop/endloop moves the complete loop block; Alt-drag a loop boundary to resize its scope.';
      indexCell.addEventListener('click',event=>{ event.stopPropagation(); selectTimeScanIndex(row,event); });
      indexCell.addEventListener('dragstart',event=>startTimeScanDrag(row,event));
      indexCell.addEventListener('dragend',cancelTimeScanDrag);
    }
    renumberTimeScanRows();
    saveTimeEstimateState();
    return row;
  }

  function timeScanRowValues(row){
    if(!row) return null;
    const command=row.querySelector('[data-time-variable]')?.value || 's1';
    const ranges={};
    row.querySelectorAll('[data-time-range-key]').forEach(input=>{ ranges[input.dataset.timeRangeKey]=input.value; });
    return {
      command,
      ranges,
      mcu:row.querySelector('[data-time-mcu]')?.value ?? '',
      fixed:!!row.querySelector('[data-time-fix]')?.checked
    };
  }

  function timeLoopBlockRows(row){
    if(!row) return [];
    const rows=timeScanRows();
    const command=row.querySelector('[data-time-variable]')?.value || '';
    let loopRow=row, endRow=null;
    if(command==='loop') endRow=matchingTimeLoopRow(row);
    else if(command==='endloop'){ loopRow=matchingTimeLoopRow(row); endRow=row; }
    else return [row];
    if(!loopRow || !endRow) return [row];
    const a=rows.indexOf(loopRow), b=rows.indexOf(endRow);
    if(a<0 || b<a) return [row];
    return rows.slice(a,b+1);
  }

  function expandTimeRowsToLoopBlocks(rows){
    const all=timeScanRows();
    const set=new Set();
    for(const row of rows){
      for(const member of timeLoopBlockRows(row)) set.add(member);
    }
    return all.filter(row=>set.has(row));
  }

  function timeScanInsertionReferenceAfterSelection(){
    const selected=selectedTimeScanRows();
    if(!selected.length) return null;
    // selectedTimeScanRows() follows document order, so the final item is the
    // lowest selected index even when the selection is non-contiguous.
    const last=selected[selected.length-1];
    const command=last.querySelector('[data-time-variable]')?.value || '';
    // Selecting a loop command means “insert inside this loop”, immediately
    // before its automatically paired endloop.
    if(command==='loop'){
      const endRow=matchingTimeLoopRow(last);
      if(endRow) return endRow;
    }
    // Selecting an endloop is also treated as an insertion point inside that
    // loop. This makes it possible to grow a newly-created nested loop simply by
    // selecting either boundary and pressing + Add scan.
    if(command==='endloop') return last;
    return last.nextElementSibling;
  }

  function selectOnlyTimeScanRow(row){
    if(!row) return;
    for(const r of timeScanRows()) r.classList.remove('time-scan-selected');
    row.classList.add('time-scan-selected');
    timeScanSelectionAnchor=row;
    updateTimeFixHeaderState();
  }

  function addTimeScanAfterSelection(){
    const before=timeScanInsertionReferenceAfterSelection();
    const row=addTimeScanRow({}, {before});
    // Continue sequence editing from the row that was just inserted. This is
    // especially important for nested loops: if this row is changed to loop,
    // the next + Add scan goes between that loop and its paired endloop instead
    // of using an older outer-loop selection.
    if(row) selectOnlyTimeScanRow(row);
    clearTimeEstimateMessage();
    saveTimeEstimateState();
  }

  function copySelectedOrLastTimeScanRows(){
    const rows=timeScanRows();
    if(!rows.length){ setTimeEstimateMessage('There is no scan to copy.',true); return; }

    const selected=selectedTimeScanRows();
    let sources;
    if(selected.length){
      sources=expandTimeRowsToLoopBlocks(selected);
    }else{
      const last=rows[rows.length-1];
      sources=(last.querySelector('[data-time-variable]')?.value==='endloop') ? timeLoopBlockRows(last) : [last];
    }
    const copies=sources.map(row=>timeScanRowValues(row)).filter(Boolean);
    const before=selected.length ? sources[sources.length-1]?.nextElementSibling || null : null;
    for(const values of copies) addTimeScanRow(values,{before,suppressAutoPair:true});
    ensureTimeLoopPairIds();
    renumberTimeScanRows();
    clearTimeEstimateMessage();
    saveTimeEstimateState();
  }

  function removeSelectedTimeScanRows(){
    const selected=selectedTimeScanRows();
    if(!selected.length) return;
    ensureTimeLoopPairIds();
    const toRemove=new Set(selected);
    for(const row of selected){
      const command=row.querySelector('[data-time-variable]')?.value || '';
      if(command==='loop' || command==='endloop'){
        const pair=matchingTimeLoopRow(row);
        if(pair) toRemove.add(pair);
      }
    }
    for(const row of toRemove){
      if(timeScanSelectionAnchor===row) timeScanSelectionAnchor=null;
      row.remove();
    }
    clearTimeScanSelection();
    ensureTimeLoopPairIds();
    renumberTimeScanRows();
    clearTimeEstimateMessage();
    saveTimeEstimateState();
  }

  function parseTimeMathExpression(raw,row=null,{allowLoopReference=true}={}){
    const text=String(raw??'').trim();
    if(!text) return {ok:false,error:'Enter a numeric expression.'};
    let pos=0;
    const refs=[];
    const skip=()=>{ while(/\s/.test(text[pos]||'')) pos++; };
    const parsePrimary=()=>{
      skip();
      if(text[pos]==='('){
        pos++;
        const node=parseAddSub();
        skip();
        if(text[pos]!==')') throw new Error('Missing closing parenthesis.');
        pos++;
        return node;
      }
      const rest=text.slice(pos);
      const loop=/^loop([1-9]\d*)\b/i.exec(rest);
      if(loop){
        if(!allowLoopReference || !row) throw new Error(`${loop[0]} is not allowed here.`);
        const ref=parseTimeLoopReferenceToken(loop[0],row);
        if(!ref?.ok) throw new Error(ref?.error||`${loop[0]} is not available at this command.`);
        pos+=loop[0].length;
        refs.push({pair:ref.loopRow?.dataset?.timeLoopPair||'',level:ref.loopRef});
        return {type:'loop',level:ref.loopRef};
      }
      const num=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      if(!num) throw new Error(`Unexpected token near "${rest.slice(0,12)}".`);
      pos+=num[0].length;
      return {type:'number',value:Number(num[0])};
    };
    const parseUnary=()=>{
      skip();
      if(text[pos]==='+' || text[pos]==='-'){
        const op=text[pos++];
        return {type:'unary',op,node:parseUnary()};
      }
      return parsePrimary();
    };
    const parseMulDiv=()=>{
      let node=parseUnary();
      while(true){
        skip();
        const op=text[pos];
        if(op!=='*' && op!=='/') break;
        pos++;
        node={type:'binary',op,left:node,right:parseUnary()};
      }
      return node;
    };
    const parseAddSub=()=>{
      let node=parseMulDiv();
      while(true){
        skip();
        const op=text[pos];
        if(op!=='+' && op!=='-') break;
        pos++;
        node={type:'binary',op,left:node,right:parseMulDiv()};
      }
      return node;
    };
    const evaluate=(node,context={})=>{
      if(node.type==='number') return node.value;
      if(node.type==='loop') return Number(context?.[node.level]);
      if(node.type==='unary'){
        const v=evaluate(node.node,context);
        return node.op==='-' ? -v : v;
      }
      const a=evaluate(node.left,context), b=evaluate(node.right,context);
      if(node.op==='+') return a+b;
      if(node.op==='-') return a-b;
      if(node.op==='*') return a*b;
      if(node.op==='/') return b===0 ? NaN : a/b;
      return NaN;
    };
    try{
      const ast=parseAddSub();
      skip();
      if(pos!==text.length) throw new Error(`Unexpected token near "${text.slice(pos,pos+12)}".`);
      const constant=refs.length===0 ? evaluate(ast,{}) : NaN;
      if(refs.length===0 && !Number.isFinite(constant)) throw new Error('Expression does not evaluate to a finite number.');
      return {ok:true,ast,refs,value:constant,evaluate:(context)=>evaluate(ast,context)};
    }catch(err){
      return {ok:false,error:err?.message||String(err)};
    }
  }

  function parseTimeRange(raw,row=null,{allowLoopReference=true}={}){
    const text=String(raw??'').trim();
    if(!text) return {ok:false,error:'Enter one fixed value or initial final step.'};
    if(text.includes(',')) return {ok:false,error:'Commas are not allowed. Separate Detail values with spaces.'};

    // A complete arithmetic expression is a fixed value. This allows SPICE forms
    // such as 4/6+(loop1-1)*1/6 while preserving the existing three-value scan
    // syntax (initial final step).
    const whole=parseTimeMathExpression(text,row,{allowLoopReference});
    if(whole.ok){
      return {
        ok:true,fixed:true,count:1,value:whole.refs.length?null:whole.value,
        expression:whole,expressionText:text,symbolic:whole.refs.length>0,
        textRefs:whole.refs
      };
    }

    const parts=text.split(/\s+/).filter(Boolean);
    if(parts.length!==3) return {ok:false,error:'Use one arithmetic expression or three space-separated values: initial final step.'};
    const expressions=parts.map(part=>parseTimeMathExpression(part,row,{allowLoopReference:false}));
    const invalid=expressions.find(x=>!x.ok);
    if(invalid) return {ok:false,error:`Every scan range value must be numeric arithmetic without loop references. ${invalid.error||''}`.trim()};
    const [initial,final,enteredStep]=expressions.map(x=>x.value);
    const step=Math.abs(enteredStep);
    if(!(step>0)) return {ok:false,error:'Step must be non-zero.'};
    const distance=Math.abs(final-initial);
    const count=distance<1e-12 ? 1 : Math.floor(distance/step+1e-10)+1;
    if(!(count>=1) || !Number.isFinite(count)) return {ok:false,error:'Could not determine the number of scan points.'};
    return {ok:true,fixed:false,count,initial,final,step};
  }

  function parseBrHklDetail(raw,row=null){
    const text=String(raw??'').trim();
    if(!text) return {ok:false,error:'Enter H K L as three space-separated values.'};
    if(text.includes(',')) return {ok:false,error:'Commas are not allowed. Enter H K L with spaces.'};
    const parts=text.split(/\s+/).filter(Boolean);
    if(parts.length!==3) return {ok:false,error:'br requires exactly three space-separated values: H K L.'};
    const components=[], textRefs=[];
    for(const token of parts){
      const expr=parseTimeMathExpression(token,row,{allowLoopReference:true});
      if(!expr.ok) return {ok:false,error:`Each br HKL value must be a numeric expression. ${expr.error||''}`.trim()};
      components.push({
        ok:true,fixed:true,count:1,value:expr.refs.length?null:expr.value,token,
        expression:expr,symbolic:expr.refs.length>0,textRefs:expr.refs
      });
      textRefs.push(...expr.refs);
    }
    return {ok:true,fixed:true,count:1,tuple:components,textRefs};
  }

  function parseTimeDetail(raw,command,row=null){
    if(command==='br') return parseBrHklDetail(raw,row);
    const kind=timeCommandMeta(command).kind;
    if(kind==='scan') return parseTimeRange(raw,row,{allowLoopReference:true});
    if(kind==='loop'){
      const parsed=parseTimeRange(raw,row,{allowLoopReference:false});
      if(!parsed.ok) return parsed;
      if(parsed.fixed) return {ok:false,error:'loop requires three space-separated values: initial final step.'};
      return parsed;
    }
    if(kind==='endloop') return {ok:true,fixed:true,count:1,value:null};
    const text=String(raw??'').trim();
    // drive/driverel/count-style single-value fields use the same arithmetic
    // expression parser as scan fixed values.  This intentionally accepts
    // expressions such as loop1-1, (loop2+1)/6, or 4/6 while preserving the
    // binding to the enclosing loop pair when rows are reordered.
    const expression=parseTimeMathExpression(text,row,{allowLoopReference:true});
    if(!expression.ok){
      return {ok:false,error:`Enter one numeric expression${row?' using loopN if needed':''}. ${expression.error||''}`.trim()};
    }
    return {
      ok:true,fixed:true,count:1,value:expression.refs.length?null:expression.value,
      expression,expressionText:text,symbolic:expression.refs.length>0,
      textRefs:expression.refs
    };
  }

  function validateTimeRangeInput(input){
    const row=input?.closest?.('.time-scan-row') || null;
    const command=row?.querySelector('[data-time-variable]')?.value || 's1';
    if(input?.dataset.timeLoopRefBroken==='1'){
      const broken={ok:false,error:'The referenced loop is no longer an enclosing loop. Re-enter loop1, loop2, ... for the new nesting.'};
      setTimeInputInvalid(input,true);
      return broken;
    }
    const parsed=parseTimeDetail(input?.value,command,row);
    if(input){
      if(parsed.ok && Array.isArray(parsed.textRefs) && parsed.textRefs.length){
        input.dataset.timeLoopTextPairs=JSON.stringify(parsed.textRefs.map(ref=>({pair:ref.pair,level:ref.level})));
        delete input.dataset.timeLoopRefPair;
        delete input.dataset.timeLoopRefPairs;
      }else if(timeCommandMeta(command).target==='br' && parsed.ok && Array.isArray(parsed.tuple)){
        const refs=parsed.tuple.map((item,tokenIndex)=>item.symbolic && item.loopRow?.dataset.timeLoopPair ? {tokenIndex,pair:item.loopRow.dataset.timeLoopPair} : null).filter(Boolean);
        if(refs.length) input.dataset.timeLoopRefPairs=JSON.stringify(refs);
        else delete input.dataset.timeLoopRefPairs;
        delete input.dataset.timeLoopRefPair;
      }else if(parsed.ok && parsed.symbolic && parsed.loopRow?.dataset.timeLoopPair){
        input.dataset.timeLoopRefPair=parsed.loopRow.dataset.timeLoopPair;
        delete input.dataset.timeLoopRefPairs;
      }else if(!parsed.symbolic){
        delete input.dataset.timeLoopRefPair;
        delete input.dataset.timeLoopRefPairs;
        delete input.dataset.timeLoopTextPairs;
      }
    }
    setTimeInputInvalid(input,!parsed.ok);
    return parsed;
  }

  function validateTimeMcuInput(input){
    const raw=String(input?.value??'').trim();
    const value=Number(raw);
    const ok=raw!=='' && /^\d+$/.test(raw) && Number.isSafeInteger(value) && value>=0;
    setTimeInputInvalid(input,!ok);
    return {ok,value};
  }

  function clearTimeEstimateMessage(){
    const box=$('timeEstimateMessage');
    if(!box) return;
    box.textContent='';
    box.classList.remove('error-text','warning-text');
    if(currentGeometryCardTab()==='time') requestAnimationFrame(updateTimeScanScrollState);
  }

  function setTimeEstimateMessage(message,error=false,warning=false){
    const box=$('timeEstimateMessage');
    if(!box) return;
    box.textContent=message;
    box.classList.toggle('error-text',!!error);
    box.classList.toggle('warning-text',!error && !!warning);
    if(currentGeometryCardTab()==='time') requestAnimationFrame(updateTimeScanScrollState);
  }

  function readTimeScanRow(row,index){
    setTimeScanRowWarning(row,false);
    const command=row.querySelector('[data-time-variable]')?.value || 's1';
    const meta=timeCommandMeta(command);
    const rangeInputs=[...row.querySelectorAll('[data-time-range-key]')];
    const parsed=rangeInputs.map(input=>({input,key:input.dataset.timeRangeKey,parsed:validateTimeRangeInput(input)}));
    const timeInput=row.querySelector('[data-time-mcu]');
    const invalidRange=parsed.find(x=>!x.parsed.ok);
    if(invalidRange){
      setTimeScanRowWarning(row,true);
      return {ok:false,error:`Command ${index}: ${invalidRange.parsed.error}`};
    }

    let timeSeconds=0;
    const time=validateTimeMcuInput(timeInput);
    if(!time.ok){
      setTimeScanRowWarning(row,true);
      return {ok:false,error:`Command ${index}: ${meta.kind==='wait'?'wait time (s)':'MCU'} must be a non-negative whole number.`};
    }
    timeSeconds=time.value;

    const movingCounts=(meta.kind==='scan' || meta.kind==='loop') ? parsed.map(x=>x.parsed.count).filter(n=>n>1) : [];
    const unique=[...new Set(movingCounts)];
    if(unique.length>1){
      for(const x of parsed) if(x.parsed.count>1) setTimeInputInvalid(x.input,true);
      setTimeScanRowWarning(row,true);
      return {ok:false,error:`Command ${index}: ranged Detail values do not contain the same number of scan points.`};
    }
    const points=meta.kind==='scan' ? (unique[0]||1) : ((meta.kind==='loop' || meta.kind==='endloop') ? 0 : 1);
    const loopIterations=meta.kind==='loop' ? (parsed[0]?.parsed?.count || 1) : 1;
    if(command==='hkle' && !parsed.some(x=>x.parsed.symbolic)){
      const parsedByKey=Object.fromEntries(parsed.map(x=>[x.key,x.parsed]));
      const plane=validateHkleScanPlane(parsedByKey,points);
      if(!plane.ok){
        setTimeScanRowWarning(row,true);
        const where=plane.hkl ? ` (${plane.hkl.map(v=>Number(v.toPrecision(6))).join(', ')})` : '';
        const detail=plane.error ? ` ${plane.error}` : '';
        return {ok:false,error:`Command ${index}: HKL scan is outside the current U-V scattering plane${where}.${detail}`};
      }
    }
    const allDetailsFixed=meta.kind==='scan' && parsed.length>0 && parsed.every(x=>x.parsed.fixed);
    const forcedFixed=meta.kind!=='scan' || allDetailsFixed;
    return {
      ok:true,
      command,
      kind:meta.kind,
      points,
      loopIterations,
      loopLevel:Number(row.dataset.timeLoopLevel||0),
      mcuSeconds:timeSeconds,
      seconds:meta.kind==='wait' ? timeSeconds : points*timeSeconds,
      fixed:forcedFixed || !!row.querySelector('[data-time-fix]')?.checked
    };
  }

  function timeRangeValues(parsed){
    if(!parsed?.ok) return [];
    if(parsed.fixed) return [parsed.value];
    const values=[];
    const direction=parsed.final>=parsed.initial ? 1 : -1;
    for(let i=0;i<parsed.count;i++) values.push(parsed.initial+direction*parsed.step*i);
    return values;
  }

  function timeLoopContextsForRow(row,structure,maxContexts=50000){
    const parentLoops=structure.info.get(row)?.parentLoops||[];
    let contexts=[{}];
    for(const loopRow of parentLoops){
      const level=structure.info.get(loopRow)?.level||0;
      const input=loopRow.querySelector('[data-time-range-key="loop"]');
      const parsed=parseTimeDetail(input?.value,'loop',loopRow);
      if(!parsed.ok) return {ok:false,contexts:[]};
      const values=timeRangeValues(parsed);
      const next=[];
      for(const context of contexts){
        for(const value of values){
          next.push({...context,[level]:value});
          if(next.length>maxContexts) return {ok:false,contexts:[],tooMany:true};
        }
      }
      contexts=next;
    }
    return {ok:true,contexts};
  }

  function resolveTimeFixedValue(parsed,context){
    if(!parsed?.ok) return NaN;
    if(parsed.expression?.ok){
      const value=parsed.expression.evaluate(context||{});
      return Number.isFinite(value) ? value : NaN;
    }
    if(parsed.symbolic) return Number(context?.[parsed.loopRef]);
    return Number(parsed.value);
  }

  function timeDetailValueAt(parsed,index,context){
    if(parsed?.fixed) return resolveTimeFixedValue(parsed,context);
    return timeHklValueAt(parsed,index);
  }

  function timeEnergyForTransfer(hw){
    const transfer=Number(hw);
    const fixed=num('energy');
    const mode=$('energyMode')?.value || 'Ef fixed';
    if(!(fixed>0) || !Number.isFinite(transfer)) return null;
    const Ei=mode==='Ei fixed' ? fixed : fixed+transfer;
    const Ef=mode==='Ef fixed' ? fixed : fixed-transfer;
    if(!(Ei>0) || !(Ef>0)) return null;
    return {Ei,Ef};
  }

  function timeElasticIncidentEnergy(){
    const E=num('energy');
    return E>0 ? E : NaN;
  }

  function timeS2MagnitudeFromQ(q,hw){
    const energy=timeEnergyForTransfer(hw);
    if(!energy || !(Number(q)>=0)) return null;
    const ki=Math.sqrt(energy.Ei/2.072), kf=Math.sqrt(energy.Ef/2.072);
    const cosS2=(ki*ki+kf*kf-Number(q)*Number(q))/(2*ki*kf);
    if(cosS2<-1-1e-10 || cosS2>1+1e-10) return null;
    return {s2:Math.abs(rad2deg(Math.acos(clamp(cosS2,-1,1)))),Ei:energy.Ei};
  }

  function timeS2LimitAtEi(Ei){
    try{
      const inst=currentInstrument();
      const s2max=effectiveS2MaxAtEi(inst,Ei,false);
      return Number.isFinite(s2max) ? s2max : null;
    }catch(_e){ return null; }
  }

  function timeSignedS2FromMagnitude(s2){
    const mag=Math.abs(Number(s2));
    if(!Number.isFinite(mag)) return NaN;
    const convention=tasConvention(checkedValue('sense'),checkedValue('s1sign'));
    return convention.s2EncoderSign*mag;
  }

  function timePreviousBrS2(row,index,context,structure){
    const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')];
    const currentIndex=Math.max(0,Number(index)-1);
    for(let i=currentIndex-1;i>=0;i--){
      const candidate=rows[i];
      if(!candidate) continue;
      const command=candidate.querySelector('[data-time-variable]')?.value || 's1';
      if(command!=='br') continue;
      const input=candidate.querySelector('[data-time-range-key="hkl"]');
      const parsed=parseTimeDetail(input?.value,'br',candidate);
      if(!parsed.ok) continue;
      let rl;
      try{ rl=buildResolutionLattice().rl; }catch(_e){ return null; }
      const resolveIn=(ctx)=>{
        const tuple=parsed.tuple||[];
        const hkl=tuple.map(part=>resolveTimeFixedValue(part,ctx));
        if(hkl.length!==3 || hkl.some(v=>!Number.isFinite(v))) return null;
        const q=norm(hklToQ(rl,hkl));
        const calc=timeS2MagnitudeFromQ(q,0);
        if(!calc) return null;
        return {s2:timeSignedS2FromMagnitude(calc.s2),Ei:calc.Ei,hkl};
      };
      const direct=resolveIn(context);
      if(direct) return direct;
      const candidateContexts=timeLoopContextsForRow(candidate,structure);
      if(candidateContexts.ok && candidateContexts.contexts.length){
        for(let j=candidateContexts.contexts.length-1;j>=0;j--){
          const fallback=resolveIn(candidateContexts.contexts[j]);
          if(fallback) return fallback;
        }
      }
    }
    return null;
  }

  function timeRowS2LimitWarning(row,result,index,structure){
    const command=result.command;
    if(!['s2','rels2','th2th','qe','hkle','br'].includes(command)) return null;
    const contextResult=timeLoopContextsForRow(row,structure);
    if(!contextResult.ok) return contextResult.tooMany ? `Command ${index}: S2 limit check skipped because the enclosing loops expand beyond 50,000 combinations.` : null;

    const inputs=[...row.querySelectorAll('[data-time-range-key]')];
    const parsedByKey={};
    for(const input of inputs){
      const key=input.dataset.timeRangeKey;
      const parsed=parseTimeDetail(input.value,command,row);
      if(!parsed.ok) return null;
      parsedByKey[key]=parsed;
    }
    const points=Math.max(1,result.points||1);
    let worst=null;
    let rl=null;
    if(command==='hkle' || command==='br'){
      try{ rl=buildResolutionLattice().rl; }catch(_e){ return null; }
    }

    const consider=(s2,Ei,detail)=>{
      if(!Number.isFinite(s2)) return;
      const incident=Number.isFinite(Ei) ? Ei : timeElasticIncidentEnergy();
      const limit=timeS2LimitAtEi(incident);
      if(!Number.isFinite(limit)) return;
      const excess=Math.abs(s2)-limit;
      if(excess>1e-8 && (!worst || excess>worst.excess)) worst={s2:Math.abs(s2),limit,Ei:incident,excess,detail};
    };

    for(const context of contextResult.contexts){
      if(command==='br'){
        const tuple=parsedByKey.hkl?.tuple||[];
        const hkl=tuple.map(part=>resolveTimeFixedValue(part,context));
        if(hkl.length!==3 || hkl.some(v=>!Number.isFinite(v))) continue;
        const q=norm(hklToQ(rl,hkl));
        const calc=timeS2MagnitudeFromQ(q,0);
        if(calc) consider(calc.s2,calc.Ei,`HKL=(${hkl.map(v=>Number(v.toPrecision(6))).join(', ')})`);
        continue;
      }
      for(let point=0;point<points;point++){
        if(command==='s2' || command==='th2th'){
          const key=command==='s2'?'s2':'th2th';
          const value=timeDetailValueAt(parsedByKey[key],point,context);
          consider(Math.abs(value),timeElasticIncidentEnergy(),`${key}=${Number(value.toPrecision?.(6)??value)}`);
        }else if(command==='rels2'){
          const rel=timeDetailValueAt(parsedByKey.s2,point,context);
          const base=timePreviousBrS2(row,index,context,structure);
          if(!base || !Number.isFinite(rel)) continue;
          const finalS2=base.s2+rel;
          consider(finalS2,base.Ei,`previous br S2=${base.s2.toFixed(2)}°, rel S2=${Number(rel.toPrecision?.(6)??rel)}`);
        }else if(command==='qe'){
          const q=timeDetailValueAt(parsedByKey.q,point,context);
          const hw=timeDetailValueAt(parsedByKey.hw,point,context);
          const calc=timeS2MagnitudeFromQ(q,hw);
          if(calc) consider(calc.s2,calc.Ei,`Q=${Number(q.toPrecision(6))}, ħω=${Number(hw.toPrecision(6))}`);
        }else if(command==='hkle'){
          const hkl=['h','k','l'].map(key=>timeDetailValueAt(parsedByKey[key],point,context));
          const hw=timeDetailValueAt(parsedByKey.hw,point,context);
          if(hkl.some(v=>!Number.isFinite(v)) || !Number.isFinite(hw)) continue;
          const q=norm(hklToQ(rl,hkl));
          const calc=timeS2MagnitudeFromQ(q,hw);
          if(calc) consider(calc.s2,calc.Ei,`HKL=(${hkl.map(v=>Number(v.toPrecision(6))).join(', ')}), ħω=${Number(hw.toPrecision(6))}`);
        }
      }
    }
    if(!worst) return null;
    return `Command ${index}: S2=${worst.s2.toFixed(2)}° exceeds the instrument max ${worst.limit.toFixed(2)}° at Ei=${worst.Ei.toFixed(2)} meV (${worst.detail}).`;
  }

  function validateAllTimeScanRows({showMessage=false}={}){
    const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')];
    const results=[],errors=[],warnings=[];
    for(const row of rows) setTimeScanS2LimitWarning(row,false);
    const loopStack=[];
    for(let i=0;i<rows.length;i++){
      const result=readTimeScanRow(rows[i],i+1);
      results.push(result);
      if(!result.ok){ errors.push(result.error); continue; }
      if(result.kind==='loop') loopStack.push(i);
      else if(result.kind==='endloop'){
        if(!loopStack.length){
          setTimeScanRowWarning(rows[i],true);
          errors.push(`Command ${i+1}: endloop has no matching loop.`);
        }else loopStack.pop();
      }
    }
    for(const i of loopStack){
      setTimeScanRowWarning(rows[i],true);
      errors.push(`Command ${i+1}: loop has no matching endloop.`);
    }
    updateTimeLoopIndentation();
    if(!errors.length){
      const structure=ensureTimeLoopPairIds();
      let darkCache=null;
      if(checkedValue('sampleMode')==='single' && $('addDark')?.checked){
        try{ darkCache=deps.singleCache || calculateSingleCrystal(); }catch(_e){ darkCache=null; }
      }
      for(let i=0;i<rows.length;i++){
        const result=results[i];
        if(!result?.ok || result.kind==='loop' || result.kind==='endloop') continue;
        const rowWarnings=timeRowMotionWarnings(rows[i],result,i+1,structure,darkCache);
        if(rowWarnings.length){
          warnings.push(...rowWarnings);
          setTimeScanS2LimitWarning(rows[i],true,rowWarnings.join(' / '));
        }
      }
    }
    if(showMessage){
      if(errors.length) setTimeEstimateMessage(errors.join(' / '),true);
      else if(warnings.length) setTimeEstimateMessage(`Warning: ${warnings.join(' / ')}`,false,true);
      else clearTimeEstimateMessage();
    }
    return {ok:errors.length===0,rows,results,errors,warnings};
  }

  function pad2(v){ return String(v).padStart(2,'0'); }
  function ceilDateToMinute(date){
    const d=new Date(date.getTime());
    if(d.getSeconds()!==0 || d.getMilliseconds()!==0) d.setMinutes(d.getMinutes()+1);
    d.setSeconds(0,0);
    return d;
  }
  function timeEstimateDatePartIds(prefix){
    return {
      date:`timeEstimate${prefix}Date`,
      hour:`timeEstimate${prefix}Hour`,
      minute:`timeEstimate${prefix}Minute`
    };
  }
  function writeTimeEstimateDate(prefix,date){
    const ids=timeEstimateDatePartIds(prefix);
    const dateInput=$(ids.date), hourInput=$(ids.hour), minuteInput=$(ids.minute);
    if(dateInput) dateInput.value=`${date.getFullYear()}-${pad2(date.getMonth()+1)}-${pad2(date.getDate())}`;
    if(hourInput) hourInput.value=pad2(date.getHours());
    if(minuteInput) minuteInput.value=pad2(date.getMinutes());
    for(const input of [dateInput,hourInput,minuteInput]) setTimeInputInvalid(input,false);
    saveTimeEstimateState();
  }
  function normalizeTimeDigits(input,max){
    if(!input) return;
    let value=String(input.value||'').replace(/\D/g,'').slice(0,2);
    input.value=value;
    if(value==='') return;
    const n=Number(value);
    if(Number.isInteger(n) && n>=0 && n<=max) setTimeInputInvalid(input,false);
  }
  function readTimeEstimateDate(prefix,label){
    const ids=timeEstimateDatePartIds(prefix);
    const dateInput=$(ids.date), hourInput=$(ids.hour), minuteInput=$(ids.minute);
    const dateText=String(dateInput?.value||'').trim();
    const hourText=String(hourInput?.value||'').trim();
    const minuteText=String(minuteInput?.value||'').trim();
    const dateMatch=/^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
    const hour=Number(hourText), minute=Number(minuteText);
    const dateOk=!!dateMatch;
    const hourOk=/^\d{1,2}$/.test(hourText) && Number.isInteger(hour) && hour>=0 && hour<=23;
    const minuteOk=/^\d{1,2}$/.test(minuteText) && Number.isInteger(minute) && minute>=0 && minute<=59;
    setTimeInputInvalid(dateInput,!dateOk);
    setTimeInputInvalid(hourInput,!hourOk);
    setTimeInputInvalid(minuteInput,!minuteOk);
    if(!dateOk || !hourOk || !minuteOk) return {ok:false,error:`Enter a valid ${label} (24-hour HH:MM).`};
    const year=Number(dateMatch[1]), month=Number(dateMatch[2]), day=Number(dateMatch[3]);
    const date=new Date(year,month-1,day,hour,minute,0,0);
    const exact=date.getFullYear()===year && date.getMonth()===month-1 && date.getDate()===day && date.getHours()===hour && date.getMinutes()===minute;
    if(!exact){
      setTimeInputInvalid(dateInput,true);
      return {ok:false,error:`Enter a valid ${label}.`};
    }
    return {ok:true,date,dateInput,hourInput,minuteInput};
  }
  function setTimeEstimateStartToNow(){
    writeTimeEstimateDate('Start',ceilDateToMinute(new Date()));
    clearTimeEstimateMessage();
  }
  function formatEstimatedDuration(seconds){
    const s=Math.max(0,Math.ceil(seconds));
    const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
    const parts=[];
    if(h) parts.push(`${h} h`);
    if(m || h) parts.push(`${m} min`);
    parts.push(`${sec} s`);
    return parts.join(' ');
  }

  function calculateTimeEstimate(){
    clearTimeEstimateMessage();
    const scanData=readAllTimeScans();
    if(!scanData.ok){ setTimeEstimateMessage(scanData.error,true); return; }
    const startResult=readTimeEstimateDate('Start','scan start time');
    if(!startResult.ok){ setTimeEstimateMessage(startResult.error,true); return; }
    const endExact=new Date(startResult.date.getTime()+scanData.totalSeconds*1000);
    const endDisplay=ceilDateToMinute(endExact);
    writeTimeEstimateDate('End',endDisplay);
    saveTimeEstimateState();
    setTimeEstimateMessage(`Estimated duration: ${formatEstimatedDuration(scanData.totalSeconds)} / ${scanData.totalPoints} execution step${scanData.totalPoints===1?'':'s'} in ${scanData.rows.length} command${scanData.rows.length===1?'':'s'}.`);
  }

  function readAllTimeScans(){
    const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')];
    if(!rows.length) return {ok:false,error:'Add at least one command.'};
    const validation=validateAllTimeScanRows();
    if(!validation.ok) return {ok:false,error:validation.errors.join(' / ')};

    const scans=[];
    const stack=[];
    let multiplier=1,totalSeconds=0,totalPoints=0;

    for(let i=0;i<rows.length;i++){
      const result=validation.results[i];
      if(result.kind==='loop'){
        const iterations=result.loopIterations||1;
        stack.push({rowIndex:i+1,iterations,previousMultiplier:multiplier});
        multiplier*=iterations;
        if(!Number.isFinite(multiplier) || multiplier>Number.MAX_SAFE_INTEGER){
          setTimeScanRowWarning(rows[i],true);
          return {ok:false,error:`Command ${i+1}: loop nesting produces too many repetitions.`};
        }
        continue;
      }
      if(result.kind==='endloop'){
        const opened=stack.pop();
        if(!opened){
          setTimeScanRowWarning(rows[i],true);
          return {ok:false,error:`Command ${i+1}: endloop has no matching loop.`};
        }
        multiplier=opened.previousMultiplier;
        continue;
      }

      const effectiveSeconds=result.seconds*multiplier;
      const effectivePoints=result.points*multiplier;
      scans.push({row:rows[i],...result,loopMultiplier:multiplier,effectiveSeconds,effectivePoints});
      totalSeconds+=effectiveSeconds;
      totalPoints+=effectivePoints;
    }

    if(stack.length){
      const opened=stack[stack.length-1];
      setTimeScanRowWarning(rows[opened.rowIndex-1],true);
      return {ok:false,error:`Command ${opened.rowIndex}: loop has no matching endloop.`};
    }
    return {ok:true,rows,scans,totalSeconds,totalPoints};
  }

  function validTimeEstimateDateInput(prefix,label){
    return readTimeEstimateDate(prefix,label);
  }

  function formatScaledMcu(value){
    if(!Number.isFinite(value)) return '';
    // Calc MCU must never round upward past the available time.  Display the
    // rescaled scan time as an integer number of seconds by truncating downward.
    return String(Math.floor(Math.max(0,value)));
  }

  function calculateTimeEstimateMcu(){
    clearTimeEstimateMessage();
    const scanData=readAllTimeScans();
    if(!scanData.ok){ setTimeEstimateMessage(scanData.error,true); return; }
    const startResult=validTimeEstimateDateInput('Start','scan start time');
    if(!startResult.ok){ setTimeEstimateMessage(startResult.error,true); return; }
    const endResult=validTimeEstimateDateInput('End','scan finish time');
    if(!endResult.ok){ setTimeEstimateMessage(endResult.error,true); return; }
    const targetSeconds=(endResult.date.getTime()-startResult.date.getTime())/1000;
    if(!(targetSeconds>0)){
      for(const input of [endResult.dateInput,endResult.hourInput,endResult.minuteInput]) setTimeInputInvalid(input,true);
      setTimeEstimateMessage('Scan finish must be later than scan start.',true);
      return;
    }

    const fixedScans=scanData.scans.filter(scan=>scan.fixed);
    const adjustableScans=scanData.scans.filter(scan=>!scan.fixed);
    const fixedSeconds=fixedScans.reduce((sum,scan)=>sum+scan.effectiveSeconds,0);
    const adjustableSeconds=adjustableScans.reduce((sum,scan)=>sum+scan.effectiveSeconds,0);
    const remainingSeconds=targetSeconds-fixedSeconds;
    const eps=1e-9;

    if(remainingSeconds < -eps){
      setTimeEstimateMessage(`Fixed commands already require ${formatEstimatedDuration(fixedSeconds)}, which exceeds the available ${formatEstimatedDuration(targetSeconds)}.`,true);
      return;
    }
    if(!adjustableScans.length){
      const difference=Math.abs(targetSeconds-fixedSeconds);
      if(difference<=0.01) setTimeEstimateMessage('All adjustable scan times are fixed. The current times already match the requested finish time.');
      else setTimeEstimateMessage('There are no unfixed scan times available to adjust.',true);
      return;
    }
    if(!(adjustableSeconds>0)){
      if(remainingSeconds<=eps){
        for(const scan of adjustableScans){
          const input=scan.row.querySelector('[data-time-mcu]');
          if(input) input.value='0';
        }
        saveTimeEstimateState();
        setTimeEstimateMessage('Unfixed scan t (s) values set to 0; fixed commands use the full available time.');
        return;
      }
      setTimeEstimateMessage('At least one unfixed scan t (s) value must be greater than zero to use the entered times as relative weights.',true);
      return;
    }

    const scale=Math.max(0,remainingSeconds)/adjustableSeconds;
    for(const scan of adjustableScans){
      const input=scan.row.querySelector('[data-time-mcu]');
      if(!input) continue;
      input.value=formatScaledMcu(scan.mcuSeconds*scale);
      setTimeInputInvalid(input,false);
    }
    // Fixed rows remain untouched. Every unfixed MCU is multiplied by the same
    // scale factor, preserving the relative weighting among adjustable scans.
    saveTimeEstimateState();
    const updated=readAllTimeScans();
    const actual=updated.ok?updated.totalSeconds:targetSeconds;
    setTimeEstimateMessage(`Unfixed scan t (s) values scaled by ×${Number(scale.toPrecision(6))}; ${fixedScans.length} fixed command${fixedScans.length===1?'':'s'} unchanged. Target duration: ${formatEstimatedDuration(targetSeconds)}; calculated duration: ${formatEstimatedDuration(actual)}.`);
  }

  function initializeTimeEstimateUI(){
    $('geometryTabAngles')?.addEventListener('click',()=>setGeometryCardTab('angles'));
    $('geometryTabTime')?.addEventListener('click',()=>setGeometryCardTab('time'));
    $('timeAddScan')?.addEventListener('click',event=>{ event.stopPropagation(); addTimeScanAfterSelection(); });
    $('timeCopyScan')?.addEventListener('click',event=>{ event.stopPropagation(); copySelectedOrLastTimeScanRows(); });
    $('timeRemoveScan')?.addEventListener('click',event=>{ event.stopPropagation(); removeSelectedTimeScanRows(); });
    $('timeEstimateCalc')?.addEventListener('click',calculateTimeEstimate);
    $('timeEstimateCalcMcu')?.addEventListener('click',calculateTimeEstimateMcu);
    $('timeEstimateNow')?.addEventListener('click',setTimeEstimateStartToNow);
    for(const id of ['timeMcuSecondsPerUnit','timeMovementPercent']){
      $(id)?.addEventListener('input',()=>{ saveTimeEstimateState(); clearTimeEstimateMessage(); });
      $(id)?.addEventListener('change',()=>{
        saveTimeEstimateState();
        const settings=v57ReadTimeSettings();
        if(!settings.ok) setTimeEstimateMessage(settings.error,true);
        else validateAllTimeScanRows({showMessage:true});
      });
    }
    window.addEventListener('resize',()=>{if(currentGeometryCardTab()==='time'){updateTimeScanScrollState();}});
    $('timeFixAll')?.addEventListener('click',event=>event.stopPropagation());
    $('timeFixAll')?.addEventListener('change',applyTimeFixHeader);
    const scanWrap=document.querySelector('#geometryTimePane .time-scan-table-wrap');
    scanWrap?.addEventListener('dragover',updateTimeScanDragTarget);
    scanWrap?.addEventListener('drop',finishTimeScanDrop);
    scanWrap?.addEventListener('dragleave',event=>{
      if(!timeScanDragState) return;
      if(event.relatedTarget && scanWrap.contains(event.relatedTarget)) return;
      clearTimeScanDragMarkers();
      timeScanDragState.rows.forEach(r=>r.classList.add('time-drag-source'));
      timeScanDragState.target=null;
    });
    document.addEventListener('click',event=>{
      if(!selectedTimeScanRows().length) return;
      if(event.target.closest?.('.time-scan-table-wrap')) return;
      clearTimeScanSelection();
    });
    for(const id of ['a','b','c','alpha','beta','gamma','Uh','Uk','Ul','Vh','Vk','Vl','instrument','energy','energyMode','S2maxUser','S2maxEffective']){
      $(id)?.addEventListener('change',()=>{
        const scriptActive=$('tabScript')?.classList.contains('active');
        if(currentGeometryCardTab()==='time' || scriptActive) validateAllTimeScanRows({showMessage:true});
      });
    }
    for(const prefix of ['Start','End']){
      const ids=timeEstimateDatePartIds(prefix);
      $(ids.date)?.addEventListener('input',()=>{ setTimeInputInvalid($(ids.date),false); clearTimeEstimateMessage(); saveTimeEstimateState(); });
      $(ids.hour)?.addEventListener('input',()=>{ normalizeTimeDigits($(ids.hour),23); clearTimeEstimateMessage(); saveTimeEstimateState(); });
      $(ids.minute)?.addEventListener('input',()=>{ normalizeTimeDigits($(ids.minute),59); clearTimeEstimateMessage(); saveTimeEstimateState(); });
      $(ids.hour)?.addEventListener('blur',()=>{ const input=$(ids.hour); if(input?.value!=='') input.value=pad2(Number(input.value)); readTimeEstimateDate(prefix,`${prefix.toLowerCase()} time`); saveTimeEstimateState(); });
      $(ids.minute)?.addEventListener('blur',()=>{ const input=$(ids.minute); if(input?.value!=='') input.value=pad2(Number(input.value)); readTimeEstimateDate(prefix,`${prefix.toLowerCase()} time`); saveTimeEstimateState(); });
      $(ids.date)?.addEventListener('change',()=>{ readTimeEstimateDate(prefix,`${prefix.toLowerCase()} time`); saveTimeEstimateState(); });
    }
    const restored=restoreTimeEstimateState();
    if(!restored){
      if(!$('timeScanRows')?.children.length) addTimeScanRow({variable:'s1'});
      if(!$('timeEstimateStartDate')?.value) setTimeEstimateStartToNow();
      setGeometryCardTab('angles');
      saveTimeEstimateState();
    }
  }


  // ==================== SPICE macro script ====================
  let timeEstimateHomeParent=null;
  let timeEstimateHomeNextSibling=null;
  const SPICE_SCRIPT_STORAGE_KEY='tas-simulator-spice-script-v1';
  const SPICE_LOOP_VARS=['i','j','k','l','m','n','p','q','r','s','t','u','v','w','x','y','z'];

  function mountTimeEstimateForScript(active){
    const pane=$('geometryTimePane');
    if(!pane) return;
    const infoRow=pane.querySelector('.time-info-row');
    const commandActions=document.querySelector('.script-command-actions');
    const asetToggle=$('scriptAsetToggle');
    if(!timeEstimateHomeParent){
      timeEstimateHomeParent=pane.parentElement;
      timeEstimateHomeNextSibling=pane.nextSibling;
    }
    if(active){
      const mount=$('scriptTimeMount');
      if(mount && pane.parentElement!==mount) mount.appendChild(pane);
      if(infoRow && commandActions && asetToggle && infoRow.parentElement!==commandActions){
        infoRow.classList.add('time-info-row-inline');
        commandActions.insertBefore(infoRow,asetToggle);
      }
      pane.classList.remove('hidden');
      requestAnimationFrame(()=>{
        updateTimeScanScrollState();
        validateAllTimeScanRows({showMessage:true});
      });
    }else{
      if(infoRow && infoRow.parentElement!==pane){
        infoRow.classList.remove('time-info-row-inline');
        pane.insertBefore(infoRow,pane.firstChild);
      }
      if(timeEstimateHomeParent && pane.parentElement!==timeEstimateHomeParent){
        if(timeEstimateHomeNextSibling && timeEstimateHomeNextSibling.parentNode===timeEstimateHomeParent){
          timeEstimateHomeParent.insertBefore(pane,timeEstimateHomeNextSibling);
        }else timeEstimateHomeParent.appendChild(pane);
      }
      pane.classList.toggle('hidden',currentGeometryCardTab()!=='time');
    }
  }

  function scriptMessage(message,error=false,warning=false){
    const box=$('scriptMessage');
    if(!box) return;
    box.textContent=message||'';
    box.classList.toggle('error-text',!!error);
    box.classList.toggle('warning-text',!error && !!warning);
  }

  function spiceLoopVar(level){
    const index=Math.max(0,Number(level||1)-1);
    return SPICE_LOOP_VARS[index] || `v${level}`;
  }

  function spiceDetailToken(token,row=null){
    const text=String(token??'').trim();
    // Time estimate expressions may contain loop references inside arithmetic,
    // e.g. 4/6+(loop1-1)*1/6.  SPICE expects the active loop variable form
    // (%i, %j, ...), so translate every embedded loopN reference, not only a
    // token that consists solely of loopN.
    return text.replace(/\bloop([1-9]\d*)\b/gi,(match,levelText)=>{
      const level=Number(levelText);
      if(row){
        const ref=parseTimeLoopReferenceToken(`loop${level}`,row);
        if(!ref?.ok) throw new Error(ref?.error||`${match} is not available at this command.`);
        return `%${spiceLoopVar(ref.loopRef)}`;
      }
      return `%${spiceLoopVar(level)}`;
    });
  }

  function spiceDetailTokens(value,row=null){
    return String(value??'').trim().split(/\s+/).filter(Boolean).map(token=>spiceDetailToken(token,row));
  }

  function spiceNameForDetailKey(key){
    return key==='hw' ? 'e' : key;
  }

  function generateSpiceMacroFromTimeEstimate(){
    const validation=validateAllTimeScanRows({showMessage:true});
    if(!validation.ok) throw new Error(validation.errors.join(' / '));
    const structure=ensureTimeLoopPairIds();
    const lines=[];
    const pushLine=(info,text)=>{
      const depth=Math.max(0,Number(info?.depth)||0);
      lines.push(`${' '.repeat(depth)}${text}`);
    };
    for(const row of structure.rows){
      const command=row.querySelector('[data-time-variable]')?.value || 's1';
      const meta=timeCommandMeta(command);
      const info=structure.info.get(row);
      if(meta.kind==='loop'){
        const input=row.querySelector('[data-time-range-key="loop"]');
        const values=spiceDetailTokens(input?.value);
        if(values.length!==3) throw new Error(`loop${info?.level||1} requires initial final step.`);
        pushLine(info,`loop ${spiceLoopVar(info?.level||1)}=${values.join(',')}`);
        continue;
      }
      if(meta.kind==='endloop'){
        pushLine(info,'endloop');
        continue;
      }
      if(meta.kind==='wait'){
        const t=row.querySelector('[data-time-mcu]')?.value || '0';
        pushLine(info,`wait ${t}`);
        continue;
      }
      const inputs=[...row.querySelectorAll('[data-time-range-key]')];
      const details=inputs.map(input=>({key:input.dataset.timeRangeKey,tokens:spiceDetailTokens(input.value)}));
      const ranged=details.some(item=>item.tokens.length===3);
      const t=row.querySelector('[data-time-mcu]')?.value || '0';

      if(meta.kind==='drive'){
        if(command==='br'){
          const hkl=details[0]?.tokens||[];
          if(hkl.length!==3) throw new Error('br requires H K L.');
          pushLine(info,`br ${hkl.join(' ')}`);
          continue;
        }
        const token=details[0]?.tokens?.[0];
        if(token===undefined) throw new Error(`${command} requires a target value.`);
        pushLine(info,`drive ${command} ${token}`);
        continue;
      }

      if(!ranged){
        if(command==='rels1' || command==='rels2'){
          const axis=command==='rels1'?'s1':'s2';
          pushLine(info,`drel ${axis} ${details[0].tokens[0]}`);
        }else if(command==='qe'){
          const byKey=Object.fromEntries(details.map(x=>[x.key,x.tokens[0]]));
          pushLine(info,`drive q ${byKey.q} e ${byKey.hw}`);
        }else if(command==='hkle'){
          const byKey=Object.fromEntries(details.map(x=>[x.key,x.tokens[0]]));
          pushLine(info,`drive h ${byKey.h} k ${byKey.k} l ${byKey.l} e ${byKey.hw}`);
        }else{
          const name=command==='th2th'?'th2th':command;
          pushLine(info,`drive ${name} ${details[0].tokens[0]}`);
        }
        continue;
      }

      if(command==='th2th'){
        // SPICE th2th is its own scan-style command; it is not prefixed by `scan`.
        pushLine(info,`th2th ${details[0].tokens.join(' ')}`);
        continue;
      }
      const scanCommand=(command==='rels1'||command==='rels2')?'scanrel':'scan';
      const pieces=[scanCommand];
      if(command==='rels1'||command==='rels2'){
        pieces.push(command==='rels1'?'s1':'s2',...details[0].tokens);
      }else{
        for(const detail of details) pieces.push(spiceNameForDetailKey(detail.key),...detail.tokens);
      }
      pieces.push('preset','mcu',String(t));
      pushLine(info,pieces.join(' '));
    }
    return lines.join('\n');
  }

  function spiceTokenToTime(token,loopStack){
    const text=String(token??'').trim();
    return text.replace(/%([A-Za-z][A-Za-z0-9_]*)\b/g,(_match,name)=>{
      const index=loopStack.indexOf(name);
      if(index<0) throw new Error(`Loop variable %${name} is not active here.`);
      return `loop${index+1}`;
    });
  }

  function parseSpiceVariableGroups(tokens,loopStack){
    const names=new Set(['s1','s2','th2th','q','e','h','k','l']);
    const groups=[];
    let i=0;
    while(i<tokens.length){
      const name=String(tokens[i]||'').toLowerCase();
      if(!names.has(name)) throw new Error(`Unknown scan variable: ${tokens[i]||''}`);
      i++;
      const values=[];
      while(i<tokens.length && !names.has(String(tokens[i]).toLowerCase())) values.push(spiceTokenToTime(tokens[i++],loopStack));
      if(values.length!==1 && values.length!==3) throw new Error(`${name} must have one value or initial final step.`);
      groups.push({name,values});
    }
    return groups;
  }

  function parseSpiceMacroToRows(text){
    const rows=[];
    const loopStack=[];
    const lines=String(text??'').split(/\r?\n/);
    for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
      const raw=lines[lineIndex].trim();
      if(!raw || raw.startsWith('#') || raw.startsWith(';')) continue;
      const lower=raw.toLowerCase();
      let match;
      if((match=/^loop\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^,]+),([^,]+),([^,]+)\s*$/i.exec(raw))){
        const variable=match[1];
        if(loopStack.includes(variable)) throw new Error(`Line ${lineIndex+1}: loop variable ${variable} is already active.`);
        loopStack.push(variable);
        rows.push({command:'loop',ranges:{loop:`${match[2].trim()} ${match[3].trim()} ${match[4].trim()}`},mcu:'0',fixed:true});
        continue;
      }
      if(/^endloop\s*$/i.test(raw)){
        if(!loopStack.length) throw new Error(`Line ${lineIndex+1}: endloop has no matching loop.`);
        loopStack.pop();
        rows.push({command:'endloop',ranges:{},mcu:'0',fixed:true});
        continue;
      }
      if((match=/^wait\s+(\d+)\s*$/i.exec(raw))){
        rows.push({command:'wait',ranges:{},mcu:match[1],fixed:true});
        continue;
      }
      if((match=/^br\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i.exec(raw))){
        rows.push({command:'br',ranges:{hkl:[match[1],match[2],match[3]].map(v=>spiceTokenToTime(v,loopStack)).join(' ')},mcu:'0',fixed:true});
        continue;
      }
      if((match=/^th2th\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i.exec(raw))){
        // The compact th2th syntax does not carry a counting preset. Use 1 s/point on import.
        rows.push({command:'th2th',ranges:{th2th:[match[1],match[2],match[3]].map(v=>spiceTokenToTime(v,loopStack)).join(' ')},mcu:'1',fixed:false});
        continue;
      }
      const parts=raw.split(/\s+/);
      const op=parts[0].toLowerCase();
      if(op==='drive' || op==='drel'){
        const rest=parts.slice(1);
        if(op==='drel'){
          if(rest.length!==2 || !['s1','s2'].includes(rest[0].toLowerCase())) throw new Error(`Line ${lineIndex+1}: unsupported drel command.`);
          const axis=rest[0].toLowerCase();
          rows.push({command:axis==='s1'?'rels1':'rels2',ranges:{[axis]:spiceTokenToTime(rest[1],loopStack)},mcu:'0',fixed:true});
          continue;
        }
        if(rest.length===2 && ['s1','s2','th2th','temp','field'].includes(rest[0].toLowerCase())){
          const name=rest[0].toLowerCase();
          const key=(name==='temp'||name==='field')?'target':name;
          rows.push({command:name,ranges:{[key]:spiceTokenToTime(rest[1],loopStack)},mcu:'0',fixed:true});
          continue;
        }
        const groups=parseSpiceVariableGroups(rest,loopStack);
        const byName=Object.fromEntries(groups.map(g=>[g.name,g.values.join(' ')]));
        const names=groups.map(g=>g.name);
        if(names.length===2 && names.includes('q') && names.includes('e')){
          rows.push({command:'qe',ranges:{q:byName.q,hw:byName.e},mcu:'0',fixed:true});
          continue;
        }
        if(['h','k','l','e'].every(n=>names.includes(n))){
          rows.push({command:'hkle',ranges:{h:byName.h,k:byName.k,l:byName.l,hw:byName.e},mcu:'0',fixed:true});
          continue;
        }
        throw new Error(`Line ${lineIndex+1}: unsupported drive command.`);
      }
      if(op==='scan' || op==='scanrel'){
        const presetIndex=parts.findIndex((token,index)=>index>0 && token.toLowerCase()==='preset');
        if(presetIndex<0 || String(parts[presetIndex+1]||'').toLowerCase()!=='mcu' || !/^\d+$/.test(String(parts[presetIndex+2]||'')) || presetIndex+3!==parts.length){
          throw new Error(`Line ${lineIndex+1}: scan must end with preset mcu <seconds>.`);
        }
        const t=parts[presetIndex+2];
        const groups=parseSpiceVariableGroups(parts.slice(1,presetIndex),loopStack);
        const byName=Object.fromEntries(groups.map(g=>[g.name,g.values.join(' ')]));
        const names=groups.map(g=>g.name);
        if(op==='scanrel'){
          if(groups.length!==1 || !['s1','s2'].includes(groups[0].name)) throw new Error(`Line ${lineIndex+1}: scanrel supports s1 or s2.`);
          const axis=groups[0].name;
          rows.push({command:axis==='s1'?'rels1':'rels2',ranges:{[axis]:byName[axis]},mcu:t,fixed:false});
          continue;
        }
        if(groups.length===1 && ['s1','s2','th2th'].includes(groups[0].name)){
          const name=groups[0].name;
          rows.push({command:name,ranges:{[name]:byName[name]},mcu:t,fixed:false});
          continue;
        }
        if(names.length===2 && names.includes('q') && names.includes('e')){
          rows.push({command:'qe',ranges:{q:byName.q,hw:byName.e},mcu:t,fixed:false});
          continue;
        }
        if(['h','k','l','e'].every(n=>names.includes(n))){
          rows.push({command:'hkle',ranges:{h:byName.h,k:byName.k,l:byName.l,hw:byName.e},mcu:t,fixed:false});
          continue;
        }
        throw new Error(`Line ${lineIndex+1}: unsupported scan command.`);
      }
      throw new Error(`Line ${lineIndex+1}: unsupported SPICE command.`);
    }
    if(loopStack.length) throw new Error('SPICE macro ends before all loops are closed.');
    if(!rows.length) throw new Error('No supported SPICE commands were found.');
    return rows;
  }

  function replaceTimeEstimateRows(rows){
    const host=$('timeScanRows');
    if(!host) return;
    host.replaceChildren();
    timeScanRowCounter=0;
    timeLoopPairCounter=0;
    for(const values of rows) addTimeScanRow(values,{suppressAutoPair:true});
    ensureTimeLoopPairIds();
    renumberTimeScanRows();
    clearTimeScanSelection();
    saveTimeEstimateState();
    validateAllTimeScanRows({showMessage:true});
  }

  async function copySpiceScript(){
    const text=$('scriptSpiceText')?.value||'';
    if(!text.trim()){ scriptMessage('There is no SPICE macro to copy.',true); return; }
    try{
      await navigator.clipboard.writeText(text);
      scriptMessage('SPICE macro copied to the clipboard.');
    }catch(_err){
      const area=$('scriptSpiceText');
      area?.focus(); area?.select();
      const ok=document.execCommand?.('copy');
      scriptMessage(ok?'SPICE macro copied to the clipboard.':'Clipboard copy was blocked by the browser.',!ok);
    }
  }

  function initializeScriptUI(){
    const area=$('scriptSpiceText');
    try{ if(area) area.value=localStorage.getItem(SPICE_SCRIPT_STORAGE_KEY)||''; }catch(_e){}
    area?.addEventListener('input',()=>{ try{localStorage.setItem(SPICE_SCRIPT_STORAGE_KEY,area.value);}catch(_e){} scriptMessage(''); });
    $('scriptToSpice')?.addEventListener('click',()=>{
      try{
        const text=generateSpiceMacroFromTimeEstimate();
        area.value=text;
        try{localStorage.setItem(SPICE_SCRIPT_STORAGE_KEY,text);}catch(_e){}
        scriptMessage('Converted Time estimate commands to SPICE.');
      }catch(err){ scriptMessage(err?.message||String(err),true); }
    });
    $('scriptToCommands')?.addEventListener('click',()=>{
      try{
        const rows=parseSpiceMacroToRows(area?.value||'');
        replaceTimeEstimateRows(rows);
        scriptMessage(`Converted ${rows.length} SPICE command rows to Time estimate commands.`);
      }catch(err){ scriptMessage(err?.message||String(err),true); }
    });
    $('scriptCopySpice')?.addEventListener('click',copySpiceScript);
  }


  // ==================== v42 Script command model / ASET ====================
  const V42_TIME_OPERATIONS=['drive','driverel','scan','scanrel','scantitle'];
  const V42_MOTOR_TARGETS=['ei','ef','e','s1','s2','hkle','br','qe','th2th'];
  const V42_ASET_STORAGE_KEY='tas-simulator-spice-aset-v4';
  const V51_ASET_COLLAPSED_STORAGE_KEY='tas-simulator-script-aset-collapsed-v1';
  const V42_ASET_DEFAULTS={
    temperature:'drive vti <value>, drive sample <value>',
    field:'drive field <value>, drive ramp 1',
    field0:'drive zero 1'
  };
  let v42SpiceLineMap=[];
  let v42SpiceErrorLines=new Set();
  let v42SpiceWarningLines=new Set();
  let v42LastSpiceValidation=null;
  let v42SpiceAutoLinked=false;
  let v42SpiceMutationObserver=null;

  function v42EscapeHtml(value){
    return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function v42EscapeAttr(value){
    return v42EscapeHtml(value).replace(/"/g,'&quot;');
  }
  function v42InternalCommand(operation,target){
    const op=String(operation||'drive').toLowerCase();
    if(op==='scantitle' || op==='count' || op==='wait' || op==='loop' || op==='endloop') return op;
    const raw=String(target||'').trim();
    const t=v49CanonicalMotorTarget(raw);
    const allowed=v42AllTargets();
    return `${op}:${allowed.includes(t)?t:'s1'}`;
  }
  function v42CommandParts(command){
    const raw=String(command||'drive:s1').trim();
    const lower=raw.toLowerCase();
    if(lower==='scantitle' || lower==='count' || lower==='wait' || lower==='loop' || lower==='endloop') return {op:lower,target:''};
    const colon=raw.indexOf(':');
    if(colon>0){
      const op=raw.slice(0,colon).toLowerCase(), target=v49CanonicalMotorTarget(raw.slice(colon+1));
      if(['drive','driverel','scan','scanrel'].includes(op) && v42AllTargets().includes(target)) return {op,target};
    }
    return {op:'drive',target:'s1'};
  }
  function v42DetailsLookRanged(ranges){
    return Object.values(ranges||{}).some(value=>String(value??'').trim().split(/\s+/).filter(Boolean).length===3);
  }
  function v42NormalizeStoredRow(values={}){
    let ranges={...(values.ranges||values.details||{})};
    const requestedRaw=String(values.command??values.variable??'s1').trim();
    const requested=requestedRaw.toLowerCase();
    if(/^(drive|driverel|scan|scanrel):/i.test(requestedRaw)){
      const parts=v42CommandParts(requestedRaw);
      if(parts.op==='drive' && parts.target==='br' && ranges.hkl===undefined){
        const compact=[ranges.h,ranges.k,ranges.l].filter(value=>value!==undefined).join(' ').trim();
        if(compact) ranges={hkl:compact};
      }
      return {operation:values.operation||parts.op,target:values.target||parts.target,ranges,migrationWarning:values.migrationWarning||''};
    }
    if(requested==='scantitle' || requested==='count' || requested==='wait' || requested==='loop' || requested==='endloop') return {operation:requested,target:'',ranges};
    const ranged=v42DetailsLookRanged(ranges);
    if(requested==='s1' || requested==='s2') return {operation:ranged?'scan':'drive',target:requested,ranges};
    if(requested==='rels1' || requested==='rels2') return {operation:ranged?'scanrel':'driverel',target:requested.endsWith('1')?'s1':'s2',ranges};
    if(requested==='hkle') return {operation:ranged?'scan':'drive',target:'hkle',ranges};
    if(requested==='temp') return {operation:'drive',target:'temperature',ranges:{target:ranges.target??ranges.temperature??''}};
    if(requested==='field') return {operation:'drive',target:'field',ranges:{target:ranges.target??ranges.field??''}};
    if(requested==='br'){
      let compact=String(ranges.hkl??ranges.target??'').trim();
      if(!compact) compact=[ranges.h,ranges.k,ranges.l].filter(value=>value!==undefined).join(' ').trim();
      return {operation:'drive',target:'br',ranges:{hkl:compact}};
    }
    if(requested==='th2th') return {operation:ranged?'scan':'drive',target:'s2',ranges:{s2:ranges.th2th??ranges.s2??''},migrationWarning:'Legacy th2th was migrated to S2. Verify the intended motor before running.'};
    if(requested==='qe') return {operation:ranged?'scan':'drive',target:'e',ranges:{hw:ranges.hw??ranges.e??''},migrationWarning:'Legacy QE cannot be represented by the new target list because Q is not a selectable target. Recreate this command as HKLE before use.'};
    return {operation:'drive',target:'s1',ranges};
  }
  function v42SetInternalSelect(select,value){
    if(!select) return;
    select.innerHTML=`<option value="${v42EscapeAttr(value)}">${v42EscapeHtml(value)}</option><option value="loop">loop</option><option value="endloop">endloop</option><option value="wait">wait</option>`;
    select.value=value;
  }
  function v42OperationOptions(selected){
    const operations=['drive','driverel','scan','scanrel','scantitle','count','wait','loop'];
    const options=operations.map(op=>`<option value="${op}"${selected===op?' selected':''}>${op}</option>`).join('');
    const end=`<option value="endloop"${selected==='endloop'?' selected':' hidden disabled'}>endloop</option>`;
    return options+end;
  }
  function v42NormalizeTemplateSyntax(template){
    // v50: ASET templates use only <value> and <range>. Scan/scanrel timing is
    // supplied automatically from the Time estimate row's MCU. Migrate the
    // former count preset mcu <time> helper out of saved templates.
    return String(template??'')
      .replace(/count\s+preset\s+mcu\s*(?:<time>|\btime\b)/gi,'')
      .replace(/(?<!<)\b(value|range)\b(?!>)/gi,'<$1>');
  }
  function v42TemplateCommands(template){
    return v42NormalizeTemplateSyntax(template).split(/[,;\n]+/).map(x=>x.trim()).filter(Boolean);
  }
  function v42TemplatePlaceholders(template){
    const commands=v42TemplateCommands(template), out=[];
    let occurrence=0;
    for(const command of commands){
      const re=/<(value|range)>/gi; let m;
      while((m=re.exec(command))){
        const type=m[1].toLowerCase();
        const before=command.slice(0,m.index).trim();
        const words=before.match(/[A-Za-z][A-Za-z0-9_]*/g)||[];
        let label=words.length?words[words.length-1]:type;
        if(['drive','driverel','scan','scanrel','preset','mcu','count'].includes(label.toLowerCase())) label=type;
        out.push({type,label,key:`aset_${type}_${++occurrence}`});
      }
    }
    return out;
  }
  function v42TemplateUsesValue(template){ return v42TemplatePlaceholders(template).some(x=>x.type==='value'); }

  function v42StoredAsetEntries(){
    try{
      const saved=JSON.parse(localStorage.getItem(V42_ASET_STORAGE_KEY)||'null');
      if(Array.isArray(saved?.entries)) return saved.entries;
    }catch(_e){}
    // Migrate the editable-template v3 list as a complete list.
    try{
      const old=JSON.parse(localStorage.getItem('tas-simulator-spice-aset-v3')||'null');
      if(Array.isArray(old?.entries) && old.entries.length) return old.entries;
    }catch(_e){}
    // Migrate v2 device-list ASETs into command templates.
    try{
      const old=JSON.parse(localStorage.getItem('tas-simulator-spice-aset-v2')||'null');
      if(Array.isArray(old?.entries)) return old.entries.map(item=>({
        key:item?.key,
        template:Array.isArray(item?.devices)?item.devices.map(d=>`drive ${d} <value>`).join(', '):''
      }));
    }catch(_e){}
    try{
      const old=JSON.parse(localStorage.getItem('tas-simulator-spice-aset-v1')||'null');
      if(old && typeof old==='object') return Object.entries(old).map(([key,devices])=>({
        key,template:Array.isArray(devices)?devices.map(d=>`drive ${d} <value>`).join(', '):''
      }));
    }catch(_e){}
    return [];
  }
  function v42AsetRowKey(row){
    return String(row?.querySelector?.('[data-aset-target]')?.value??row?.dataset?.asetKey??'').trim();
  }
  function v49CanonicalMotorTarget(value){
    const raw=String(value??'').trim();
    const lower=raw.toLowerCase();
    return V42_MOTOR_TARGETS.includes(lower)?lower:raw;
  }

  function v42AsetKeys(){
    const keys=new Set();
    for(const row of document.querySelectorAll('#scriptAsetList [data-aset-row]')){
      const key=v42AsetRowKey(row);
      if(/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && !V42_MOTOR_TARGETS.includes(key.toLowerCase())) keys.add(key);
    }
    if(!keys.size){
      for(const item of v42StoredAsetEntries()){
        const key=String(item?.key||'').trim();
        if(/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && !V42_MOTOR_TARGETS.includes(key.toLowerCase())) keys.add(key);
      }
    }
    if(!keys.size) for(const key of Object.keys(V42_ASET_DEFAULTS)) keys.add(key);
    return [...keys];
  }
  function v42AllTargets(){ return [...V42_MOTOR_TARGETS,...v42AsetKeys()]; }
  function v42TargetsForOperation(operation){
    const op=String(operation||'drive').toLowerCase();
    if(['scantitle','count','wait','loop','endloop'].includes(op)) return [];
    const scanOnly=new Set(['qe','th2th']);
    return v42AllTargets().filter(t=>{
      // QE and th2th are dedicated scan targets. br is a positioning-only command.
      if(scanOnly.has(t)) return op==='scan';
      if(t==='br') return op==='drive';
      // Relative HKLE is not a supported SPICE operation, so do not offer it.
      if(t==='hkle' && (op==='driverel' || op==='scanrel')) return false;
      return true;
    });
  }
  function v42TargetOptions(selected,operation='drive'){
    const labels={ei:'Ei',ef:'Ef',e:'E',s1:'S1',s2:'S2',hkle:'HKLE',br:'br',qe:'QE',th2th:'th2th'};
    const targets=v42TargetsForOperation(operation);
    return `<option value="">—</option>`+targets.map(t=>`<option value="${v42EscapeAttr(t)}"${selected===t?' selected':''}>${v42EscapeHtml(labels[t]||t)}</option>`).join('');
  }
  function v42AsetTemplate(key){
    const target=String(key||'').trim();
    const row=[...document.querySelectorAll('#scriptAsetList [data-aset-row]')].find(r=>v42AsetRowKey(r)===target);
    const input=row?.querySelector('[data-aset-template]');
    if(input) return v42NormalizeTemplateSyntax(String(input.value||'').trim());
    const stored=v42StoredAsetEntries().find(item=>String(item?.key||'').trim()===target);
    if(stored?.template!==undefined) return v42NormalizeTemplateSyntax(String(stored.template||'').trim());
    const defaultKey=Object.prototype.hasOwnProperty.call(V42_ASET_DEFAULTS,target)?target:null;
    return v42NormalizeTemplateSyntax(String(defaultKey?V42_ASET_DEFAULTS[defaultKey]:'').trim());
  }
  function v42AsetEntries(){
    return [...document.querySelectorAll('#scriptAsetList [data-aset-row]')].map(row=>({
      key:v42AsetRowKey(row),
      template:v42NormalizeTemplateSyntax(String(row.querySelector('[data-aset-template]')?.value||'').trim())
    })).filter(item=>/^[A-Za-z][A-Za-z0-9_]*$/.test(item.key) && !V42_MOTOR_TARGETS.includes(item.key.toLowerCase()));
  }
  function v42RenumberAsetRows(){
    [...document.querySelectorAll('#scriptAsetList [data-aset-row]')].forEach((row,i)=>{
      const cell=row.querySelector('[data-aset-index]'); if(cell) cell.textContent=String(i+1);
    });
  }
  function v42RefreshTargetSelects(){
    document.querySelectorAll('#timeScanRows [data-time-target]').forEach(select=>{
      const row=select.closest('.time-scan-row');
      const operation=row?.querySelector('[data-time-operation]')?.value||'drive';
      const previous=select.value;
      const allowed=v42TargetsForOperation(operation);
      select.innerHTML=v42TargetOptions(previous,operation);
      if(allowed.includes(previous)) select.value=previous;
      else if(!select.disabled){ select.value=allowed.includes('s1')?'s1':(allowed[0]||''); }
      else select.value='';
    });
  }
  function v42CreateAsetRow(key='',template='',{removable=true}={}){
    const host=$('scriptAsetList'); if(!host) return null;
    const row=document.createElement('div');
    row.className='script-aset-item'; row.dataset.asetRow='1';
    row.innerHTML=`<span class="script-aset-index" data-aset-index></span>`+
      `<input type="text" data-aset-target value="${v42EscapeAttr(String(key||''))}" placeholder="target" spellcheck="false" aria-label="ASET target">`+
      `<textarea data-aset-template rows="2" placeholder="drive device <value>\nscan device <range>" spellcheck="false" aria-label="ASET SPICE template">${v42EscapeHtml(String(template||''))}</textarea>`+
      `${removable?'<button type="button" class="script-aset-remove" title="Remove ASET" aria-label="Remove ASET">×</button>':'<span></span>'}`;
    host.appendChild(row); v42RenumberAsetRows(); return row;
  }
  function v42SaveAset(){
    const payload={entries:v42AsetEntries()};
    try{ localStorage.setItem(V42_ASET_STORAGE_KEY,JSON.stringify(payload)); }catch(_e){}
  }
  function v42LoadAset(){
    const host=$('scriptAsetList'); if(!host) return;
    const entries=v42StoredAsetEntries();
    host.replaceChildren();
    if(entries.length){
      entries.forEach((item,index)=>{
        const key=String(item?.key||'').trim();
        if(!key || V42_MOTOR_TARGETS.includes(key.toLowerCase())) return;
        v42CreateAsetRow(key,v42NormalizeTemplateSyntax(String(item?.template||'')),{removable:true});
      });
    }else{
      for(const [key,template] of Object.entries(V42_ASET_DEFAULTS)) v42CreateAsetRow(key,template,{removable:true});
    }
    v42RenumberAsetRows();
  }
  function v42PromptAddAset(){
    const row=v42CreateAsetRow('','',{removable:true});
    row?.querySelector('[data-aset-target]')?.focus();
    scriptMessage('Added an empty ASET row. Enter Target and SPICE template directly in the list.');
  }
  function v42ValidateAsetRows(){
    const seen=new Set(); let ok=true, message='';
    for(const row of document.querySelectorAll('#scriptAsetList [data-aset-row]')){
      const key=v42AsetRowKey(row), target=row.querySelector('[data-aset-target]'), template=row.querySelector('[data-aset-template]');
      const validKey=/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && !V42_MOTOR_TARGETS.includes(key.toLowerCase()) && !seen.has(key);
      target?.classList.toggle('invalid',!validKey);
      if(validKey) seen.add(key); else if(!message) message=key?`ASET Target "${key}" is invalid or duplicated.`:'Enter an ASET Target name.';
      const validTemplate=v42TemplateCommands(template?.value).length>0;
      template?.classList.toggle('invalid',!validTemplate);
      if(!validTemplate && !message) message=`ASET ${key||'?'} needs at least one SPICE template command.`;
      ok=ok&&validKey&&validTemplate;
    }
    return {ok,message};
  }

  // Composite command metadata. Control rows remain standalone; motion rows are operation:target.
  timeCommandMeta = function(command){
    const {op,target}=v42CommandParts(command);
    if(op==='scantitle') return {kind:'scantitle',op,target:'',specs:[{key:'title',label:'Title'}]};
    if(op==='count') return {kind:'count',op,target:'',specs:[]};
    if(op==='wait') return {kind:'wait',op,target:'',specs:[]};
    if(op==='loop') return {kind:'loop',op,target:'',specs:[{key:'loop',label:'Loop'}]};
    if(op==='endloop') return {kind:'endloop',op,target:'',specs:[]};
    const kind=(op==='scan' || op==='scanrel') ? 'scan' : 'drive';
    if(target==='qe') return {kind,op,target,specs:[{key:'q',label:'Q'},{key:'hw',label:'E'}]};
    if(target==='th2th') return {kind,op,target,specs:[{key:'th2th',label:'th2th'}]};
    if(target==='hkle') return {kind,op,target,specs:[{key:'h',label:'H'},{key:'k',label:'K'},{key:'l',label:'L'},{key:'hw',label:'E'}]};
    if(target==='br') return {kind:'drive',op:'drive',target,specs:[{key:'hkl',label:'HKL'}]};
    if(v42AsetKeys().includes(target)){
      const placeholders=v42TemplatePlaceholders(v42AsetTemplate(target));
      const specs=placeholders.map(p=>({key:p.key,label:p.label,placeholderType:p.type}));
      return {kind,op,target,aset:true,specs,placeholders};
    }
    const key=(target==='e')?'hw':target;
    const label={ei:'Ei',ef:'Ef',e:'E',s1:'S1',s2:'S2'}[target]||target;
    return {kind,op,target,specs:[{key,label:(op==='driverel'||op==='scanrel')?`rel ${label}`:label}]};
  };

  function v56ParseScantitleDetail(raw,row=null){
    const text=String(raw??'').trim();
    if(!text) return {ok:false,error:'Enter a scan title.'};
    const refs=[];
    const re=/\bloop([1-9]\d*)\b/gi;
    let match;
    while((match=re.exec(text))){
      if(!row) continue;
      const ref=parseTimeLoopReferenceToken(match[0],row);
      if(!ref?.ok) return ref || {ok:false,error:`${match[0]} is not available at this command.`};
      refs.push({pair:ref.loopRow?.dataset?.timeLoopPair||'',level:ref.loopRef});
    }
    return {ok:true,fixed:true,count:1,value:text,textRefs:refs};
  }

  parseTimeDetail = function(raw,command,row=null){
    const meta=timeCommandMeta(command);
    if(meta.kind==='scantitle') return v56ParseScantitleDetail(raw,row);
    if(meta.target==='br') return parseBrHklDetail(raw,row);
    if(meta.kind==='loop'){
      const parsed=parseTimeRange(raw,row,{allowLoopReference:false});
      if(!parsed.ok) return parsed;
      if(parsed.fixed) return {ok:false,error:'loop requires three space-separated values: initial final step.'};
      return parsed;
    }
    if(meta.kind==='endloop' || meta.kind==='wait' || meta.kind==='count') return {ok:true,fixed:true,count:1,value:null};
    if(meta.kind==='scan') return parseTimeRange(raw,row,{allowLoopReference:true});
    const text=String(raw??'').trim();
    const expr=parseTimeMathExpression(text,row,{allowLoopReference:true});
    if(!expr.ok) return {ok:false,error:`Enter one numeric expression${row?' using loopN if needed':''}. ${expr.error||''}`.trim()};
    return {
      ok:true,fixed:true,count:1,value:expr.refs.length?null:expr.value,
      expression:expr,expressionText:text,symbolic:expr.refs.length>0,textRefs:expr.refs
    };
  };

  updateTimeLoopCommandLabels = function(){
    const structure=ensureTimeLoopPairIds();
    for(const row of structure.rows){
      const internal=row.querySelector('[data-time-variable]');
      const opSelect=row.querySelector('[data-time-operation]');
      if(!internal || !opSelect) continue;
      const rowInfo=structure.info.get(row);
      const loopOption=[...opSelect.options].find(option=>option.value==='loop');
      const endOption=[...opSelect.options].find(option=>option.value==='endloop');
      const proposedLevel=(internal.value==='loop' && rowInfo?.level) ? rowInfo.level : Math.max(1,(rowInfo?.depth||0)+1);
      if(loopOption) loopOption.textContent=`loop${proposedLevel}`;
      if(endOption){
        endOption.textContent=(internal.value==='endloop' && rowInfo?.level) ? `endloop${rowInfo.level}` : 'endloop';
        endOption.disabled=internal.value!=='endloop';
        endOption.hidden=internal.value!=='endloop';
      }
      opSelect.disabled=internal.value==='endloop';
      opSelect.title=internal.value==='endloop' ? 'This endloop is paired automatically with its loop command.' : '';
    }
    return structure;
  };

  addTimeScanRow = function(values={},options={}){
    const host=$('timeScanRows');
    if(!host) return null;
    const normalized=v42NormalizeStoredRow(values);
    const row=document.createElement('div');
    row.className='time-scan-row';
    row.dataset.timeScanId=String(++timeScanRowCounter);
    const initialMcu=String(values.mcu??values.time??((normalized.operation==='wait'||normalized.operation==='count')?(values.ranges?.wait??values.details?.wait??values.mcu??values.time??'') : '')).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    row.innerHTML=`
      <div class="time-scan-cell time-scan-index" data-time-index></div>
      <div class="time-scan-cell time-command-cell">
        <select data-time-operation aria-label="Command">${v42OperationOptions(normalized.operation)}</select>
        <select data-time-variable class="time-internal-command" aria-hidden="true" tabindex="-1"></select>
      </div>
      <div class="time-scan-cell time-target-cell"><select data-time-target aria-label="Target">${v42TargetOptions(normalized.target,normalized.operation)}</select></div>
      <div class="time-scan-cell"><div class="time-range-inputs" data-time-range-host></div></div>
      <div class="time-scan-cell"><span class="time-mcu-entry"><input type="text" inputmode="numeric" data-time-mcu value="${initialMcu}" placeholder="0"></span></div>
      <div class="time-scan-cell time-fix-cell"><input type="checkbox" data-time-fix aria-label="Fix time for this command"></div>`;
    const before=options?.before;
    if(before && before.parentElement===host) host.insertBefore(row,before); else host.appendChild(row);
    const opSelect=row.querySelector('[data-time-operation]');
    const targetSelect=row.querySelector('[data-time-target]');
    const internal=row.querySelector('[data-time-variable]');
    const fix=row.querySelector('[data-time-fix]');
    if(fix) fix.checked=!!values.fixed;
    if(normalized.migrationWarning) row.dataset.timeMigrationWarning=normalized.migrationWarning;

    const syncControlState=()=>{
      const structural=['scantitle','count','wait','loop','endloop'].includes(opSelect.value);
      const previousTarget=targetSelect.value;
      const allowedTargets=v42TargetsForOperation(opSelect.value);
      targetSelect.innerHTML=v42TargetOptions(previousTarget,opSelect.value);
      targetSelect.disabled=structural;
      if(structural) targetSelect.value='';
      else if(allowedTargets.includes(previousTarget)) targetSelect.value=previousTarget;
      else targetSelect.value=allowedTargets.includes('s1')?'s1':(allowedTargets[0]||'');
      const value=v42InternalCommand(opSelect.value,targetSelect.value);
      v42SetInternalSelect(internal,value);
      return value;
    };
    const initialInternal=syncControlState();
    row.dataset.timeCommand=initialInternal;
    const initialTime=row.querySelector('[data-time-mcu]');
    if(initialTime && String(initialTime.value).trim()!=='' && Number.isFinite(parseNumericValue(initialTime.value))) initialTime.value=formatTimeMcuValue(initialTime.value);
    updateTimeScanRowFields(row,normalized.ranges);

    if(initialInternal==='loop' && !options?.suppressAutoPair){
      const endRow=addTimeScanRow({command:'endloop'},{before:row.nextElementSibling,suppressAutoPair:true});
      const pair=`lp${++timeLoopPairCounter}`;
      row.dataset.timeLoopPair=pair;
      if(endRow) endRow.dataset.timeLoopPair=pair;
    }

    const handleSelectionChange=()=>{
      const previous=row.dataset.timeCommand || 'drive:s1';
      const previousPair=previous==='loop' ? matchingTimeLoopRow(row) : null;
      const next=syncControlState();
      if(previous==='loop' && next!=='loop' && previousPair){ previousPair.remove(); delete row.dataset.timeLoopPair; }
      row.dataset.timeCommand=next;
      delete row.dataset.timeMigrationWarning;
      updateTimeScanRowFields(row);
      if(previous!=='loop' && next==='loop'){
        const endRow=addTimeScanRow({command:'endloop'},{before:row.nextElementSibling,suppressAutoPair:true});
        const pair=`lp${++timeLoopPairCounter}`;
        row.dataset.timeLoopPair=pair;
        if(endRow) endRow.dataset.timeLoopPair=pair;
        selectOnlyTimeScanRow(row);
      }
      renumberTimeScanRows();
      clearTimeEstimateMessage();
      updateTimeFixHeaderState();
      saveTimeEstimateState();
      validateAllTimeScanRows({showMessage:true});
    };
    opSelect.addEventListener('change',handleSelectionChange);
    targetSelect.addEventListener('change',handleSelectionChange);

    const timeInput=row.querySelector('[data-time-mcu]');
    timeInput.addEventListener('input',()=>{
      if(timeInput.readOnly) return;
      const parsed=validateTimeMcuInput(timeInput);
      saveTimeEstimateState();
      if(parsed.ok) clearTimeEstimateMessage(); else setTimeEstimateMessage('MCU must be a non-negative whole number (wait uses seconds).',true);
    });
    timeInput.addEventListener('change',()=>{
      if(timeInput.readOnly) return;
      const parsed=validateTimeMcuInput(timeInput);
      if(parsed.ok){ timeInput.value=formatTimeMcuValue(parsed.value); applyMcuToSelectedTimeScans(row,timeInput.value); }
      saveTimeEstimateState();
      validateAllTimeScanRows({showMessage:true});
    });
    fix?.addEventListener('change',()=>{ updateTimeFixHeaderState(); saveTimeEstimateState(); });
    const indexCell=row.querySelector('[data-time-index]');
    if(indexCell){
      indexCell.draggable=true;
      indexCell.title='Click to select; drag to reorder. Loop/endloop moves the complete loop block; Alt-drag a loop boundary to resize its scope.';
      indexCell.addEventListener('click',event=>{ event.stopPropagation(); selectTimeScanIndex(row,event); });
      indexCell.addEventListener('dragstart',event=>startTimeScanDrag(row,event));
      indexCell.addEventListener('dragend',cancelTimeScanDrag);
    }
    renumberTimeScanRows();
    saveTimeEstimateState();
    return row;
  };

  timeScanRowValues = function(row){
    if(!row) return null;
    const command=row.querySelector('[data-time-variable]')?.value || 'drive:s1';
    const {op,target}=v42CommandParts(command);
    const ranges={};
    row.querySelectorAll('[data-time-range-key]').forEach(input=>{ ranges[input.dataset.timeRangeKey]=input.value; });
    return {command,operation:op,target,ranges,mcu:row.querySelector('[data-time-mcu]')?.value??'',fixed:!!row.querySelector('[data-time-fix]')?.checked};
  };

  readTimeScanRow = function(row,index){
    setTimeScanRowWarning(row,false);
    if(row.dataset.timeMigrationWarning){
      setTimeScanRowWarning(row,true);
      return {ok:false,error:`Command ${index}: ${row.dataset.timeMigrationWarning}`};
    }
    const command=row.querySelector('[data-time-variable]')?.value || 'drive:s1';
    const meta=timeCommandMeta(command);
    const rangeInputs=[...row.querySelectorAll('[data-time-range-key]')];
    const parsed=rangeInputs.map(input=>({input,key:input.dataset.timeRangeKey,parsed:validateTimeRangeInput(input)}));
    const invalidRange=parsed.find(x=>!x.parsed.ok);
    if(invalidRange){ setTimeScanRowWarning(row,true); return {ok:false,error:`Command ${index}: ${invalidRange.parsed.error}`}; }
    const timeInput=row.querySelector('[data-time-mcu]');
    const time=validateTimeMcuInput(timeInput);
    if(!time.ok){ setTimeScanRowWarning(row,true); return {ok:false,error:`Command ${index}: ${meta.kind==='wait'?'wait time (s)':'MCU'} must be a non-negative whole number.`}; }

    if((meta.target==='qe'||meta.target==='th2th') && meta.op!=='scan'){
      setTimeScanRowWarning(row,true);
      return {ok:false,error:`Command ${index}: ${meta.target==='qe'?'QE':'th2th'} is available with scan only.`};
    }
    if((meta.op==='driverel'||meta.op==='scanrel') && meta.target==='hkle'){
      setTimeScanRowWarning(row,true);
      return {ok:false,error:`Command ${index}: relative HKLE is not supported; use absolute drive/scan HKLE.`};
    }

    const movingCounts=meta.kind==='scan' ? parsed.map(x=>x.parsed.count).filter(n=>n>1) : [];
    const unique=[...new Set(movingCounts)];
    if(unique.length>1){
      for(const x of parsed) if(x.parsed.count>1) setTimeInputInvalid(x.input,true);
      setTimeScanRowWarning(row,true);
      return {ok:false,error:`Command ${index}: ranged Detail values do not contain the same number of scan points.`};
    }
    if(meta.kind==='scan' && unique.length===0){
      for(const x of parsed) setTimeInputInvalid(x.input,true);
      setTimeScanRowWarning(row,true);
      return {ok:false,error:`Command ${index}: ${meta.op} requires initial final step in at least one Detail field.`};
    }
    const points=meta.kind==='scan' ? unique[0] : ((meta.kind==='loop'||meta.kind==='endloop')?0:1);
    const loopIterations=meta.kind==='loop' ? (parsed[0]?.parsed?.count||1) : 1;
    if(meta.target==='hkle' && (meta.op==='drive'||meta.op==='scan') && !parsed.some(x=>x.parsed.symbolic)){
      const parsedByKey=Object.fromEntries(parsed.map(x=>[x.key,x.parsed]));
      const plane=validateHkleScanPlane(parsedByKey,Math.max(1,points));
      if(!plane.ok){
        setTimeScanRowWarning(row,true);
        const where=plane.hkl?` (${plane.hkl.map(v=>Number(v.toPrecision(6))).join(', ')})`:'';
        const detail=plane.error?` ${plane.error}`:'';
        return {ok:false,error:`Command ${index}: HKLE is outside the current U-V scattering plane${where}.${detail}`};
      }
    }
    const secondsPerMcu=v57TimeMcuSecondsPerUnit();
    const baseSeconds=meta.kind==='wait' ? time.value
      : (meta.kind==='count' ? time.value*secondsPerMcu
      : (meta.kind==='scan' ? points*time.value*secondsPerMcu : 0));
    return {
      ok:true,command,operation:meta.op,target:meta.target,kind:meta.kind,points,loopIterations,
      loopLevel:Number(row.dataset.timeLoopLevel||0),mcuValue:time.value,mcuSeconds:time.value,
      seconds:baseSeconds,
      fixed:meta.kind!=='scan' || !!row.querySelector('[data-time-fix]')?.checked
    };
  };

  // Script-only S2 state tracking.  This does not change any TAS/Q-E geometry
  // calculation; it only reconstructs the motor position reached by preceding
  // Script commands so relative scans can be validated at their actual positions.
  function timeFinalPointIndex(parsedByKey){
    let count=1;
    for(const parsed of Object.values(parsedByKey||{})){
      if(parsed?.ok && Number.isFinite(parsed.count)) count=Math.max(count,Number(parsed.count));
    }
    return Math.max(0,count-1);
  }

  function timeResolveCandidateS2State(candidate,rowIndex,context,structure,visiting=new Set()){
    if(!candidate || visiting.has(rowIndex)) return null;
    visiting.add(rowIndex);
    try{
      const command=candidate.querySelector('[data-time-variable]')?.value||'';
      const meta=timeCommandMeta(command);
      if(!['s2','th2th','qe','hkle','br'].includes(meta.target)) return null;

      const parsedByKey={};
      for(const input of candidate.querySelectorAll('[data-time-range-key]')){
        const parsed=parseTimeDetail(input.value,command,candidate);
        if(!parsed.ok) return null;
        parsedByKey[input.dataset.timeRangeKey]=parsed;
      }
      const finalPoint=timeFinalPointIndex(parsedByKey);

      const resolveWithContext=(ctx)=>{
        if(meta.target==='s2'){
          const parsed=parsedByKey.s2;
          const value=timeDetailValueAt(parsed,finalPoint,ctx);
          if(!Number.isFinite(value)) return null;
          if(meta.op==='driverel' || meta.op==='scanrel'){
            const base=timeS2StateBeforeIndex(rowIndex,ctx,structure,visiting);
            return base ? {...base,s2:base.s2+value,source:command} : null;
          }
          return {s2:value,Ei:timeElasticIncidentEnergy(),source:command};
        }

        if(meta.target==='th2th'){
          const value=timeDetailValueAt(parsedByKey.th2th,finalPoint,ctx);
          if(!Number.isFinite(value)) return null;
          const base=timeS2StateBeforeIndex(rowIndex,ctx,structure,visiting);
          return base ? {...base,s2:base.s2+value,source:command} : null;
        }

        if(meta.target==='qe'){
          const q=timeDetailValueAt(parsedByKey.q,finalPoint,ctx);
          const hw=timeDetailValueAt(parsedByKey.hw,finalPoint,ctx);
          if(!Number.isFinite(q)||!Number.isFinite(hw)) return null;
          const calc=timeS2MagnitudeFromQ(q,hw);
          return calc ? {s2:timeSignedS2FromMagnitude(calc.s2),Ei:calc.Ei,q,hw,source:command} : null;
        }

        let rl; try{ rl=buildResolutionLattice().rl; }catch(_e){ return null; }
        const hkl=meta.target==='br'
          ? (parsedByKey.hkl?.tuple||[]).map(item=>resolveTimeFixedValue(item,ctx))
          : ['h','k','l'].map(key=>timeDetailValueAt(parsedByKey[key],finalPoint,ctx));
        const hw=meta.target==='br'?0:timeDetailValueAt(parsedByKey.hw,finalPoint,ctx);
        if(hkl.length!==3 || hkl.some(v=>!Number.isFinite(v)) || !Number.isFinite(hw)) return null;
        const q=norm(hklToQ(rl,hkl));
        const calc=timeS2MagnitudeFromQ(q,hw);
        return calc ? {s2:timeSignedS2FromMagnitude(calc.s2),Ei:calc.Ei,hkl,hw,source:command} : null;
      };

      const direct=resolveWithContext(context);
      if(direct) return direct;
      const contexts=timeLoopContextsForRow(candidate,structure);
      if(contexts.ok){
        for(let j=contexts.contexts.length-1;j>=0;j--){
          const fallback=resolveWithContext(contexts.contexts[j]);
          if(fallback) return fallback;
        }
      }
      return null;
    }finally{
      visiting.delete(rowIndex);
    }
  }

  function timeS2StateBeforeIndex(currentIndex,context,structure,visiting=new Set()){
    const rows=timeScanRows();
    for(let i=Math.max(0,Number(currentIndex))-1;i>=0;i--){
      const state=timeResolveCandidateS2State(rows[i],i,context,structure,visiting);
      if(state) return state;
    }
    return null;
  }

  function timePreviousS2Position(row,index,context,structure){
    return timeS2StateBeforeIndex(Math.max(0,Number(index)-1),context,structure,new Set());
  }

  // Keep the historical helper name for existing rel-S2 warning code.
  timePreviousBrS2 = timePreviousS2Position;

  function timeReachabilityFromQ(q,hw){
    const energy=timeEnergyForTransfer(hw);
    if(!energy) return {ok:false,reason:'the selected energy transfer makes Ei or Ef non-positive'};
    const Q=Number(q);
    if(!(Q>=0)) return {ok:false,reason:'Q is not a valid non-negative value'};
    const ki=Math.sqrt(energy.Ei/2.072), kf=Math.sqrt(energy.Ef/2.072);
    const denom=2*ki*kf;
    const cosS2=(ki*ki+kf*kf-Q*Q)/denom;
    if(cosS2<-1-1e-10 || cosS2>1+1e-10){
      return {ok:false,reason:'the scattering triangle cannot be formed at this Q and energy',Ei:energy.Ei,Ef:energy.Ef};
    }
    const s2=Math.abs(rad2deg(Math.acos(clamp(cosS2,-1,1))));
    return {ok:true,s2,Ei:energy.Ei,Ef:energy.Ef};
  }

  function timeS2RangeWarning(s2,Ei,detail,index){
    if(!Number.isFinite(s2)) return null;
    const value=Math.abs(Number(s2));
    const min=Math.abs(Number(num('S2min')));
    const max=timeS2LimitAtEi(Ei);
    if(Number.isFinite(min) && value<min-1e-8){
      return `Command ${index}: S2=${value.toFixed(2)}° is below the instrument min ${min.toFixed(2)}° (${detail}).`;
    }
    if(Number.isFinite(max) && value>max+1e-8){
      return `Command ${index}: S2=${value.toFixed(2)}° exceeds the instrument max ${max.toFixed(2)}° at Ei=${Number(Ei).toFixed(2)} meV (${detail}).`;
    }
    return null;
  }

  function timeDarkWarningForHKLE(cache,hkl,hw,index,detail){
    if(!cache?.addDark) return null;
    const blocks=qeDarkBlockWarningsForHKLE(cache,hkl,hw);
    return blocks.length ? `Command ${index}: Dark angle ${blocks.join(' / ')} (${detail}).` : null;
  }

  function timeRowMotionWarnings(row,result,index,structure,darkCache=null){
    const meta=timeCommandMeta(result.command);
    if(!['s2','th2th','qe','hkle','br'].includes(meta.target)) return [];
    const contextResult=timeLoopContextsForRow(row,structure);
    if(!contextResult.ok){
      return contextResult.tooMany
        ? [`Command ${index}: reachability check skipped because enclosing loops expand beyond 50,000 combinations.`]
        : [];
    }
    const parsedByKey={};
    for(const input of row.querySelectorAll('[data-time-range-key]')){
      const parsed=parseTimeDetail(input.value,result.command,row);
      if(!parsed.ok) return [];
      parsedByKey[input.dataset.timeRangeKey]=parsed;
    }
    let rl=null;
    if(meta.target==='hkle'||meta.target==='br'){
      try{ rl=buildResolutionLattice().rl; }catch(_e){ return []; }
    }
    const points=Math.max(1,result.points||1), warnings=[];
    const add=message=>{ if(message && !warnings.includes(message)) warnings.push(message); };
    for(const context of contextResult.contexts){
      for(let point=0;point<points;point++){
        if(meta.target==='s2' || meta.target==='th2th'){
          const key=meta.target==='th2th'?'th2th':'s2';
          const value=timeDetailValueAt(parsedByKey[key],point,context);
          if(!Number.isFinite(value)) continue;
          if(meta.target==='th2th'){
            // SPICE th2th is a relative scan: evaluate every requested offset
            // from the S2 position reached by the preceding Script commands.
            const base=timePreviousS2Position(row,index,context,structure);
            if(!base){
              add(`Command ${index}: th2th reachability check requires a preceding position-defining command (for example br, drive/scan HKLE, or S2).`);
              continue;
            }
            const finalS2=base.s2+value;
            add(timeS2RangeWarning(finalS2,base.Ei,`base S2=${base.s2.toFixed(2)}°, th2th offset=${Number(value.toPrecision?.(6)??value)}`,index));
          }else if(meta.op==='driverel'||meta.op==='scanrel'){
            const base=timePreviousS2Position(row,index,context,structure);
            if(!base) continue;
            const finalS2=base.s2+value;
            add(timeS2RangeWarning(finalS2,base.Ei,`previous S2=${base.s2.toFixed(2)}°, rel S2=${Number(value.toPrecision?.(6)??value)}`,index));
          }else{
            const Ei=timeElasticIncidentEnergy();
            add(timeS2RangeWarning(value,Ei,`${key}=${Number(value.toPrecision?.(6)??value)}`,index));
          }
          continue;
        }

        if(meta.target==='qe'){
          const q=timeDetailValueAt(parsedByKey.q,point,context);
          const hw=timeDetailValueAt(parsedByKey.hw,point,context);
          if(!Number.isFinite(q)||!Number.isFinite(hw)) continue;
          const detail=`Q=${Number(q.toPrecision(6))}, E=${Number(hw.toPrecision(6))}`;
          const reach=timeReachabilityFromQ(q,hw);
          if(!reach.ok){ add(`Command ${index}: inaccessible point — ${reach.reason} (${detail}).`); continue; }
          add(timeS2RangeWarning(reach.s2,reach.Ei,detail,index));
          continue;
        }

        const hkl=meta.target==='br'
          ? (parsedByKey.hkl?.tuple||[]).map(item=>resolveTimeFixedValue(item,context))
          : ['h','k','l'].map(key=>timeDetailValueAt(parsedByKey[key],point,context));
        const hw=meta.target==='br'?0:timeDetailValueAt(parsedByKey.hw,point,context);
        if(hkl.length!==3 || hkl.some(v=>!Number.isFinite(v)) || !Number.isFinite(hw)) continue;
        const detail=`HKLE=(${hkl.map(v=>Number(v.toPrecision(6))).join(', ')}, ${Number(hw.toPrecision(6))})`;
        const plane=hklInCurrentScatteringPlane(hkl);
        if(!plane.ok){
          add(`Command ${index}: inaccessible point — HKL is outside the current U-V scattering plane (${detail}).`);
          continue;
        }
        const q=norm(hklToQ(rl,hkl));
        const reach=timeReachabilityFromQ(q,hw);
        if(!reach.ok){ add(`Command ${index}: inaccessible point — ${reach.reason} (${detail}).`); continue; }
        add(timeS2RangeWarning(reach.s2,reach.Ei,detail,index));
        add(timeDarkWarningForHKLE(darkCache,hkl,hw,index,detail));
      }
    }
    return warnings;
  }

  timeRowS2LimitWarning = function(row,result,index,structure){
    return timeRowMotionWarnings(row,result,index,structure,null)[0] || null;
  };

  function v42DetailItems(row){
    return [...row.querySelectorAll('[data-time-range-key]')].map(input=>({key:input.dataset.timeRangeKey,tokens:spiceDetailTokens(input.value,row)}));
  }
  function v42TemplateLinesForTarget(target,valueToken=''){
    const template=v42AsetTemplate(target);
    const commands=v42TemplateCommands(template);
    if(!commands.length) throw new Error(`${target} ASET has no SPICE template.`);
    const usesValue=v42TemplateUsesValue(template);
    if(usesValue && valueToken==='') throw new Error(`${target} ASET requires a Detail value because its template contains value.`);
    return commands.map(command=>usesValue?command.replace(/\bvalue\b/gi,valueToken):command);
  }
  function v42SpiceLinesForRow(row,info,result){
    const meta=timeCommandMeta(result.command);
    if(meta.kind==='loop'){
      const values=spiceDetailTokens(row.querySelector('[data-time-range-key="loop"]')?.value);
      return [`loop ${spiceLoopVar(info?.level||1)}=${values.join(',')}`];
    }
    if(meta.kind==='endloop') return ['endloop'];
    if(meta.kind==='scantitle'){
      const raw=String(row.querySelector('[data-time-range-key="title"]')?.value||'').trim();
      const unquoted=raw.length>=2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1,-1).trim() : raw;
      const title=unquoted.replace(/\bloop([1-9]\d*)\b/gi,token=>{
        const ref=parseTimeLoopReferenceToken(token,row);
        if(!ref?.ok) throw new Error(ref?.error||`${token} is not available at this command.`);
        return `%${spiceLoopVar(ref.loopRef)}`;
      });
      const escaped=title.replace(/"/g,'\\"');
      return [`scantitle "${escaped}"`];
    }
    if(meta.kind==='count') return [`count preset mcu ${row.querySelector('[data-time-mcu]')?.value||'0'}`];
    if(meta.kind==='wait') return [`wait ${row.querySelector('[data-time-mcu]')?.value||'0'}`];
    const details=v42DetailItems(row);
    const byKey=Object.fromEntries(details.map(item=>[item.key,item.tokens]));
    const t=row.querySelector('[data-time-mcu]')?.value||'0';
    const target=meta.target, op=meta.op;

    if(meta.aset){
      const template=v42AsetTemplate(target);
      const commands=v42TemplateCommands(template);
      if(!commands.length) throw new Error(`${target} ASET has no SPICE template.`);
      const inputs=[...row.querySelectorAll('[data-time-range-key]')];
      const values=inputs.map(input=>String(input.value||'').trim());
      let valueIndex=0;
      return commands.map(command=>{
        let expanded=command.replace(/<(value|range)>/gi,(_m,type)=>{
          const kind=String(type).toLowerCase();
          const raw=values[valueIndex++]??'';
          if(!raw) throw new Error(`${target} ASET requires a ${kind} entry.`);
          return spiceDetailTokens(raw,row).join(' ');
        });
        // Every ASET scan/scanrel consumes the row MCU automatically. This
        // keeps the template focused on motion syntax while Time estimate owns
        // counting time, e.g. "scan sgu <range>" -> "... preset mcu 300".
        if(/^scan(?:rel)?\b/i.test(expanded) && !/\bpreset\s+mcu\b/i.test(expanded)){
          expanded=`${expanded} preset mcu ${t}`;
        }
        return expanded;
      });
    }
    if(op==='drive'){
      if(target==='hkle') return [`drive h ${byKey.h[0]} k ${byKey.k[0]} l ${byKey.l[0]} e ${byKey.hw[0]}`];
      if(target==='br') return [`br ${byKey.hkl.join(' ')}`];
      const token=details[0]?.tokens?.[0];
      if(target==='ei'||target==='ef') return [`${target} ${token}`];
      return [`drive ${target} ${token}`];
    }
    if(op==='driverel'){
      const token=details[0]?.tokens?.[0];
      return [`driverel ${target} ${token}`];
    }
    if(op==='scan'){
      if(target==='th2th') return [`th2th ${details[0].tokens.join(' ')}`];
      const pieces=['scan'];
      if(target==='hkle'){
        for(const [key,name] of [['h','h'],['k','k'],['l','l'],['hw','e']]) pieces.push(name,...byKey[key]);
      }else if(target==='qe'){
        pieces.push('q',...byKey.q,'e',...byKey.hw);
      }else pieces.push(target,...details[0].tokens);
      pieces.push('preset','mcu',String(t));
      return [pieces.join(' ')];
    }
    if(op==='scanrel') return [`preset mcu ${t}`,`scanrel ${target} ${details[0].tokens.join(' ')}`];
    throw new Error(`Unsupported command ${op}.`);
  }
  function v42TemplateRegex(command){
    const text=String(command||'');
    const re=/<(value|range)>/gi;
    const esc=x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
    let source='^',last=0,m; const types=[];
    while((m=re.exec(text))){ source+=esc(text.slice(last,m.index))+'(.+?)'; types.push(m[1].toLowerCase()); last=m.index+m[0].length; }
    source+=esc(text.slice(last))+'$';
    return {regex:new RegExp(source,'i'),types};
  }

  function v42MatchAsetAtLines(lines,startIndex,loopStack){
    const nextSignificant=(from)=>{ for(let j=from;j<lines.length;j++){ const raw=lines[j].trim(); if(raw && !raw.startsWith('#') && !raw.startsWith(';')) return {index:j,raw}; } return null; };
    for(const key of v42AsetKeys()){
      const templates=v42TemplateCommands(v42AsetTemplate(key));
      if(!templates.length) continue;
      let cursor=startIndex-1,last=startIndex-1,ok=true; const captures=[]; let timeValue='0';
      for(const template of templates){
        const next=nextSignificant(cursor+1); if(!next){ok=false;break;}
        let candidate=next.raw;
        if(/^scan(?:rel)?\b/i.test(template)){
          const timed=/^(.*?)\s+preset\s+mcu\s+(\d+)\s*$/i.exec(candidate);
          if(!timed){ok=false;break;}
          candidate=timed[1].trim();
          const scanTime=timed[2];
          if(timeValue!=='0' && timeValue!==scanTime){ok=false;break;}
          timeValue=scanTime;
        }
        const {regex,types}=v42TemplateRegex(template),m=regex.exec(candidate);
        if(!m){ok=false;break;}
        for(let g=1;g<m.length;g++){
          const type=types[g-1];
          const rawValue=String(m[g]).trim();
          captures.push({type,value:rawValue.split(/\s+/).map(token=>spiceTokenToTime(token,loopStack)).join(' ')});
        }
        cursor=next.index; last=next.index;
      }
      if(ok){
        const ranges={}; let occurrence=0;
        for(const item of captures) ranges[`aset_${item.type}_${++occurrence}`]=item.value;
        return {key,ranges,mcu:timeValue,endIndex:last};
      }
    }
    return null;
  }

  function v42RenderSpiceBackdrop(){
    const area=$('scriptSpiceText'),backdrop=$('scriptSpiceBackdrop'),numbers=$('scriptSpiceLineNumbers');
    if(!area||!backdrop) return;
    const lines=String(area.value??'').split('\n');
    backdrop.innerHTML=lines.map((line,i)=>{
      const n=i+1;
      const cls=v42SpiceErrorLines.has(n)?' spice-line-error':(v42SpiceWarningLines.has(n)?' spice-line-warning':'');
      return `<span class="spice-backdrop-line${cls}">${v42EscapeHtml(line)||' '}</span>`;
    }).join('');
    if(numbers) numbers.innerHTML=lines.map((_line,i)=>{
      const n=i+1;
      const cls=v42SpiceErrorLines.has(n)?' spice-line-error':(v42SpiceWarningLines.has(n)?' spice-line-warning':'');
      return `<span class="spice-line-number${cls}">${n}</span>`;
    }).join('');
    backdrop.scrollTop=area.scrollTop; backdrop.scrollLeft=area.scrollLeft; if(numbers) numbers.scrollTop=area.scrollTop;
  }
  function v49HighlightSpiceErrorFromMessage(message){
    v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set();
    const match=/\bLine\s+(\d+)\s*:/i.exec(String(message||''));
    if(match) v42SpiceErrorLines.add(Number(match[1]));
    v42RenderSpiceBackdrop();
  }
  function v42ApplyValidationToLineHighlights(validation){
    v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set();
    if(!validation || v42SpiceLineMap.length!==validation.rows.length){ v42RenderSpiceBackdrop(); return; }
    validation.results.forEach((result,i)=>{
      const map=v42SpiceLineMap[i]; if(!map) return;
      const set=result?.ok?v42SpiceWarningLines:v42SpiceErrorLines;
      if(result?.ok && !validation.warnings?.some(w=>String(w).startsWith(`Command ${i+1}:`))) return;
      for(let line=map.start;line<=map.end;line++) set.add(line);
    });
    v42RenderSpiceBackdrop();
  }

  generateSpiceMacroFromTimeEstimate = function(){
    const validation=validateAllTimeScanRows({showMessage:true});
    const structure=ensureTimeLoopPairIds();
    const lines=[]; v42SpiceLineMap=[]; v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set();
    for(let i=0;i<structure.rows.length;i++){
      const row=structure.rows[i],result=validation.results[i],info=structure.info.get(row);
      const start=lines.length+1;
      if(!result?.ok){
        lines.push(`# ERROR Command ${i+1}: ${String(result?.error||'Invalid command').replace(/^Command\s+\d+:\s*/,'')}`);
      }else{
        try{ lines.push(...v42SpiceLinesForRow(row,info,result)); }
        catch(err){
          result.ok=false; result.error=`Command ${i+1}: ${err?.message||String(err)}`;
          if(!validation.errors.includes(result.error)) validation.errors.push(result.error);
          lines.push(`# ERROR Command ${i+1}: ${err?.message||String(err)}`);
        }
      }
      const end=lines.length;
      v42SpiceLineMap[i]={start,end};
      if(!result?.ok) for(let line=start;line<=end;line++) v42SpiceErrorLines.add(line);
      else if(validation.warnings?.some(w=>String(w).startsWith(`Command ${i+1}:`))) for(let line=start;line<=end;line++) v42SpiceWarningLines.add(line);
    }
    validation.ok=validation.errors.length===0;
    v42LastSpiceValidation=validation;
    return lines.join('\n');
  };

  parseSpiceVariableGroups = function(tokens,loopStack){
    const names=new Set(['ei','ef','e','q','s1','s2','h','k','l']);
    const groups=[]; let i=0;
    while(i<tokens.length){
      const name=String(tokens[i]||'').toLowerCase();
      if(!names.has(name)) throw new Error(`Unknown scan variable: ${tokens[i]||''}`);
      i++;
      const values=[];
      while(i<tokens.length && !names.has(String(tokens[i]).toLowerCase())) values.push(spiceTokenToTime(tokens[i++],loopStack));
      if(values.length!==1 && values.length!==3) throw new Error(`${name} must have one value or initial final step.`);
      groups.push({name,values});
    }
    return groups;
  };
  function v42RowsFromGroups(op,groups,t='0'){
    const byName=Object.fromEntries(groups.map(g=>[g.name,g.values.join(' ')]));
    const names=groups.map(g=>g.name);
    if(['h','k','l','e'].every(name=>names.includes(name))){
      return {command:`${op}:hkle`,ranges:{h:byName.h,k:byName.k,l:byName.l,hw:byName.e},mcu:t,fixed:op!=='scan'};
    }
    if(op==='scan' && groups.length===2 && names.includes('q') && names.includes('e')){
      return {command:'scan:qe',ranges:{q:byName.q,hw:byName.e},mcu:t,fixed:false};
    }
    if(groups.length===1 && ['ei','ef','e','s1','s2'].includes(groups[0].name)){
      const target=groups[0].name;
      return {command:`${op}:${target}`,ranges:{[target==='e'?'hw':target]:groups[0].values.join(' ')},mcu:t,fixed:op!=='scan'};
    }
    throw new Error(`Unsupported ${op} target combination.`);
  }

  parseSpiceMacroToRows = function(text){
    const rows=[],loopStack=[];
    const lines=String(text??'').split(/\r?\n/);
    let pendingMcu=null;
    const significant=(start)=>{ for(let j=start;j<lines.length;j++){ const raw=lines[j].trim(); if(raw && !raw.startsWith('#') && !raw.startsWith(';')) return {index:j,raw}; } return null; };
    for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
      const raw=lines[lineIndex].trim();
      if(!raw || raw.startsWith('#') || raw.startsWith(';')) continue;
      const asetMatch=v42MatchAsetAtLines(lines,lineIndex,loopStack);
      if(asetMatch){
        const template=v42AsetTemplate(asetMatch.key);
        const commands=v42TemplateCommands(template);
        const hasRange=v42TemplatePlaceholders(template).some(p=>p.type==='range');
        const operation=commands.some(c=>/^scanrel\b/i.test(c))?'scanrel':(commands.some(c=>/^scan\b/i.test(c))?'scan':(commands.some(c=>/^driverel\b/i.test(c))?'driverel':(hasRange?'scan':'drive')));
        rows.push({command:`${operation}:${asetMatch.key}`,ranges:asetMatch.ranges,mcu:asetMatch.mcu||'0',fixed:!['scan','scanrel'].includes(operation)});
        lineIndex=asetMatch.endIndex;
        continue;
      }
      let match;
      if((match=/^loop\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^,]+),([^,]+),([^,]+)\s*$/i.exec(raw))){
        if(loopStack.includes(match[1])) throw new Error(`Line ${lineIndex+1}: loop variable ${match[1]} is already active.`);
        loopStack.push(match[1]); rows.push({command:'loop',ranges:{loop:`${match[2].trim()} ${match[3].trim()} ${match[4].trim()}`},mcu:'0',fixed:true}); continue;
      }
      if(/^endloop\s*$/i.test(raw)){ if(!loopStack.length) throw new Error(`Line ${lineIndex+1}: endloop has no matching loop.`); loopStack.pop(); rows.push({command:'endloop',ranges:{},mcu:'0',fixed:true}); continue; }
      if((match=/^scantitle\s+(.+?)\s*$/i.exec(raw))){
        let title;
        try{
          const token=String(match[1]||'').trim();
          const unquoted=token.length>=2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1,-1) : token;
          title=spiceTokenToTime(unquoted.replace(/\\"/g,'"'),loopStack);
        }
        catch(err){ throw new Error(`Line ${lineIndex+1}: ${err?.message||String(err)}`); }
        rows.push({command:'scantitle',ranges:{title},mcu:'0',fixed:true}); continue;
      }
      if((match=/^wait\s+(\d+)\s*$/i.exec(raw))){ rows.push({command:'wait',ranges:{},mcu:match[1],fixed:true}); continue; }
      if((match=/^count(?:\s+preset\s+mcu)?\s+(\d+)\s*$/i.exec(raw))){ rows.push({command:'count',ranges:{},mcu:match[1],fixed:true}); continue; }
      if((match=/^br\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i.exec(raw))){ rows.push({command:'drive:br',ranges:{hkl:[match[1],match[2],match[3]].map(v=>spiceTokenToTime(v,loopStack)).join(' ')},mcu:'0',fixed:true}); continue; }
      if((match=/^preset\s+mcu\s+(\d+)\s*$/i.exec(raw))){ pendingMcu=match[1]; continue; }
      if((match=/^(ei|ef)\s+(\S+)\s*$/i.exec(raw))){
        const target=match[1].toLowerCase(); rows.push({command:`drive:${target}`,ranges:{[target]:spiceTokenToTime(match[2],loopStack)},mcu:'0',fixed:true}); continue;
      }
      const parts=raw.split(/\s+/),op=parts[0].toLowerCase();
      if(op==='drive' || op==='driverel' || op==='drel'){
        const canonical=op==='drive'?'drive':'driverel';
        const rest=parts.slice(1);
        if(rest.length===2){
          const device=rest[0].toLowerCase(),value=spiceTokenToTime(rest[1],loopStack);
          if(['ei','ef','e','s1','s2'].includes(device)){
            rows.push({command:`${canonical}:${device}`,ranges:{[device==='e'?'hw':device]:value},mcu:'0',fixed:true}); continue;
          }
        }
        if(canonical==='drive'){
          const groups=parseSpiceVariableGroups(rest,loopStack);
          rows.push(v42RowsFromGroups('drive',groups,'0')); continue;
        }
        throw new Error(`Line ${lineIndex+1}: unsupported driverel command.`);
      }
      if(op==='scan'){
        const presetIndex=parts.findIndex((token,index)=>index>0&&token.toLowerCase()==='preset');
        if(presetIndex<0 || String(parts[presetIndex+1]||'').toLowerCase()!=='mcu' || !/^\d+$/.test(String(parts[presetIndex+2]||'')) || presetIndex+3!==parts.length) throw new Error(`Line ${lineIndex+1}: scan must end with preset mcu <seconds>.`);
        const groups=parseSpiceVariableGroups(parts.slice(1,presetIndex),loopStack);
        rows.push(v42RowsFromGroups('scan',groups,parts[presetIndex+2])); continue;
      }
      if(op==='th2th'){
        if(parts.length!==4) throw new Error(`Line ${lineIndex+1}: th2th requires initial final step.`);
        const value=parts.slice(1).map(x=>spiceTokenToTime(x,loopStack)).join(' ');
        rows.push({command:'scan:th2th',ranges:{th2th:value},mcu:'1',fixed:false}); continue;
      }
      if(op==='scanrel'){
        let rest=parts.slice(1),mcu=pendingMcu||'1'; pendingMcu=null;
        const presetIndex=rest.findIndex(token=>token.toLowerCase()==='preset');
        if(presetIndex>=0){
          if(String(rest[presetIndex+1]||'').toLowerCase()!=='mcu'||!/^\d+$/.test(String(rest[presetIndex+2]||''))) throw new Error(`Line ${lineIndex+1}: invalid scanrel preset.`);
          mcu=rest[presetIndex+2]; rest=rest.slice(0,presetIndex);
        }
        if(rest.length!==4) throw new Error(`Line ${lineIndex+1}: scanrel requires target initial final step.`);
        const target=rest[0].toLowerCase(),value=rest.slice(1).map(x=>spiceTokenToTime(x,loopStack)).join(' ');
        if(!['ei','ef','e','s1','s2'].includes(target)) throw new Error(`Line ${lineIndex+1}: unsupported scanrel target ${target}.`);
        rows.push({command:`scanrel:${target}`,ranges:{[target==='e'?'hw':target]:value},mcu,fixed:false}); continue;
      }
      throw new Error(`Line ${lineIndex+1}: unsupported SPICE command.`);
    }
    if(loopStack.length) throw new Error('SPICE macro ends before all loops are closed.');
    if(!rows.length) throw new Error('No supported SPICE commands were found.');
    return rows;
  };


  // v53: ASET placeholder-specific validation. <value> remains scalar-only, while
  // <range> accepts either one fixed value / loopN reference or initial final step.
  // This lets one ASET template mix fixed and scanned axes without requiring a
  // separate template. Scan timing still comes from the row MCU.
  const v48BaseValidateTimeRangeInput=validateTimeRangeInput;
  validateTimeRangeInput = function(input){
    const key=String(input?.dataset?.timeRangeKey||'');
    const row=input?.closest?.('.time-scan-row')||null;
    const command=row?.querySelector('[data-time-variable]')?.value||'';
    const meta=timeCommandMeta(command);
    if(meta.kind==='scantitle'){
      if(input?.dataset.timeLoopRefBroken==='1'){
        const broken={ok:false,error:'A loop reference in the scan title is no longer inside that loop.'};
        setTimeInputInvalid(input,true); return broken;
      }
      const result=v56ParseScantitleDetail(input?.value,row);
      if(result.ok && input){
        const refs=(result.textRefs||[]).filter(ref=>ref.pair);
        if(refs.length) input.dataset.timeLoopTextPairs=JSON.stringify(refs);
        else delete input.dataset.timeLoopTextPairs;
        delete input.dataset.timeLoopRefPair;
        delete input.dataset.timeLoopRefPairs;
      }
      setTimeInputInvalid(input,!result.ok); return result;
    }
    if(!key.startsWith('aset_')) return v48BaseValidateTimeRangeInput(input);
    if(key.startsWith('aset_range_')){
      const result=parseTimeRange(input?.value,row,{allowLoopReference:true});
      setTimeInputInvalid(input,!result.ok); return result;
    }
    const text=String(input?.value??'').trim();
    // ASET <value> is scalar-only, but the scalar may be an arithmetic expression
    // using enclosing loop variables, e.g. loop1-1 or (loop2+1)/6.  Use the same
    // expression parser as the normal Time estimate command fields so validation,
    // loop binding, reordering, and SPICE round-tripping stay consistent.
    const expr=parseTimeMathExpression(text,row,{allowLoopReference:true});
    if(expr.ok && input){
      if(Array.isArray(expr.refs) && expr.refs.length){
        input.dataset.timeLoopTextPairs=JSON.stringify(expr.refs.map(ref=>({pair:ref.pair,level:ref.level})));
      }else{
        delete input.dataset.timeLoopTextPairs;
      }
      delete input.dataset.timeLoopRefPair;
      delete input.dataset.timeLoopRefPairs;
    }
    const result=expr.ok
      ? {ok:true,fixed:true,count:1,value:expr.refs.length?null:expr.value,expression:expr,expressionText:text,symbolic:expr.refs.length>0,textRefs:expr.refs}
      : {ok:false,error:`Enter one numeric expression using loopN if needed. ${expr.error||''}`.trim()};
    setTimeInputInvalid(input,!result.ok); return result;
  };

  initializeScriptUI = function(){
    const area=$('scriptSpiceText'),backdrop=$('scriptSpiceBackdrop'),numbers=$('scriptSpiceLineNumbers'),rowsHost=$('timeScanRows');
    v42LoadAset();
    v42RefreshTargetSelects();
    const bindInfoToggle=(buttonId,panelId)=>{
      const button=$(buttonId),panel=$(panelId);
      if(!button || !panel || button.dataset.infoBound==='1') return;
      button.dataset.infoBound='1';
      button.addEventListener('click',()=>{
        const show=panel.classList.contains('hidden');
        panel.classList.toggle('hidden',!show);
        button.setAttribute('aria-expanded',String(show));
      });
    };
    bindInfoToggle('scriptAsetInfoToggle','scriptAsetHelp');
    bindInfoToggle('timeEstimateInfoToggle','timeEstimateInfoPanel');
    const asetHost=$('scriptAsetList');
    const refreshAset=()=>{
      const check=v42ValidateAsetRows();
      v42SaveAset(); v42RefreshTargetSelects();
      for(const row of timeScanRows()){ const meta=timeCommandMeta(row.querySelector('[data-time-variable]')?.value||''); if(meta.aset) updateTimeScanRowFields(row); }
      validateAllTimeScanRows({showMessage:true});
      if(!check.ok) scriptMessage(check.message,true);
    };
    asetHost?.addEventListener('input',event=>{
      if(event.target.closest?.('[data-aset-target],[data-aset-template]')) refreshAset();
    });
    asetHost?.addEventListener('change',event=>{
      if(event.target.closest?.('[data-aset-target],[data-aset-template]')) refreshAset();
    });
    asetHost?.addEventListener('click',event=>{
      const remove=event.target.closest?.('.script-aset-remove'); if(!remove) return;
      const row=remove.closest('[data-aset-row]'); const key=v42AsetRowKey(row);
      row?.remove(); v42RenumberAsetRows(); refreshAset(); scriptMessage(`Removed ASET ${key||''}. Commands that used it must choose another Target.`);
    });
    $('scriptAsetAdd')?.addEventListener('click',v42PromptAddAset);
    const applyAsetCollapsedState=collapsed=>{
      const workspace=document.querySelector('#scriptPanel .script-workspace');
      if(!workspace) return;
      workspace.classList.toggle('aset-collapsed',!!collapsed);
      const button=$('scriptAsetToggle');
      if(button){
        button.textContent=collapsed?'▶ Show ASET':'◀ Hide ASET';
        button.setAttribute('aria-expanded',String(!collapsed));
      }
    };
    let initialAsetCollapsed=false;
    try{ initialAsetCollapsed=localStorage.getItem(V51_ASET_COLLAPSED_STORAGE_KEY)==='1'; }catch(_e){}
    applyAsetCollapsedState(initialAsetCollapsed);
    $('scriptAsetToggle')?.addEventListener('click',()=>{
      const workspace=document.querySelector('#scriptPanel .script-workspace'); if(!workspace) return;
      const collapsed=!workspace.classList.contains('aset-collapsed');
      applyAsetCollapsedState(collapsed);
      try{ localStorage.setItem(V51_ASET_COLLAPSED_STORAGE_KEY,collapsed?'1':'0'); }catch(_e){}
      requestAnimationFrame(resizeVisiblePlots);
    });
    try{ if(area) area.value=localStorage.getItem(SPICE_SCRIPT_STORAGE_KEY)||''; }catch(_e){}
    area?.addEventListener('scroll',()=>{ if(backdrop){backdrop.scrollTop=area.scrollTop;backdrop.scrollLeft=area.scrollLeft;} if(numbers) numbers.scrollTop=area.scrollTop; });
    area?.addEventListener('input',()=>{
      v42SpiceAutoLinked=false; v42SpiceLineMap=[]; v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set(); v42RenderSpiceBackdrop();
      try{localStorage.setItem(SPICE_SCRIPT_STORAGE_KEY,area.value);}catch(_e){} scriptMessage('');
    });
    // Conversion is intentionally one-shot only. Editing either side must not
    // overwrite the other side until the user explicitly presses an arrow button.
    v42SpiceAutoLinked=false;
    v42SpiceMutationObserver?.disconnect();
    v42SpiceMutationObserver=null;
    $('scriptToSpice')?.addEventListener('click',()=>{
      try{
        v42SpiceAutoLinked=false;
        const text=generateSpiceMacroFromTimeEstimate(); area.value=text; v42RenderSpiceBackdrop();
        try{localStorage.setItem(SPICE_SCRIPT_STORAGE_KEY,text);}catch(_e){}
        if(v42LastSpiceValidation?.errors?.length) scriptMessage(v57SpiceValidationSummary(v42LastSpiceValidation),true);
        else if(v42LastSpiceValidation?.warnings?.length) scriptMessage(v57SpiceValidationSummary(v42LastSpiceValidation),false,true);
        else scriptMessage('Converted Time estimate commands to SPICE. ASET placeholders were expanded into their SPICE templates.');
      }catch(err){ scriptMessage(err?.message||String(err),true); }
    });
    $('scriptToCommands')?.addEventListener('click',()=>{
      try{
        const rows=parseSpiceMacroToRows(area?.value||''); replaceTimeEstimateRows(rows); v42SpiceAutoLinked=false;
        v42RenderSpiceBackdrop();
        if(v42LastSpiceValidation?.errors?.length) scriptMessage(v57SpiceValidationSummary(v42LastSpiceValidation),true);
        else if(v42LastSpiceValidation?.warnings?.length) scriptMessage(v57SpiceValidationSummary(v42LastSpiceValidation),false,true);
        else scriptMessage(`Converted ${rows.length} SPICE command row${rows.length===1?'':'s'} to Time estimate commands.`);
      }catch(err){ v49HighlightSpiceErrorFromMessage(err?.message||String(err)); scriptMessage(err?.message||String(err),true); }
    });
    $('scriptCopySpice')?.addEventListener('click',copySpiceScript);
    v42RenderSpiceBackdrop();
  };



  // ==================== v57 MCU timing / SPICE diagnostics ====================
  function v57ReadTimeSettings({mark=true}={}){
    const mcuInput=$('timeMcuSecondsPerUnit');
    const movementInput=$('timeMovementPercent');
    const mcuText=String(mcuInput?.value??'1').trim();
    const movementText=String(movementInput?.value??'1').trim();
    const secondsPerMcu=Number(mcuText);
    const movementPercent=Number(movementText);
    const mcuOk=mcuText!=='' && Number.isFinite(secondsPerMcu) && secondsPerMcu>0;
    const movementOk=movementText!=='' && Number.isFinite(movementPercent) && movementPercent>=0;
    if(mark){
      setTimeInputInvalid(mcuInput,!mcuOk);
      setTimeInputInvalid(movementInput,!movementOk);
    }
    if(!mcuOk) return {ok:false,error:'1 MCU must correspond to a positive number of seconds.'};
    if(!movementOk) return {ok:false,error:'Movement time must be a non-negative percentage.'};
    return {ok:true,secondsPerMcu,movementPercent,movementFactor:1+movementPercent/100};
  }
  function v57TimeMcuSecondsPerUnit(){
    const settings=v57ReadTimeSettings({mark:false});
    return settings.ok?settings.secondsPerMcu:1;
  }
  function v57TimeMovementFactor(){
    const settings=v57ReadTimeSettings({mark:false});
    return settings.ok?settings.movementFactor:1.01;
  }

  // readAllTimeScans reports both the command/counting time and the final time
  // including the configurable movement overhead.
  readAllTimeScans = function(){
    const settings=v57ReadTimeSettings();
    if(!settings.ok) return settings;
    const rows=[...document.querySelectorAll('#timeScanRows .time-scan-row')];
    if(!rows.length) return {ok:false,error:'Add at least one command.'};
    const validation=validateAllTimeScanRows();
    if(!validation.ok) return {ok:false,error:validation.errors.join(' / ')};

    const scans=[];
    const stack=[];
    let multiplier=1,baseSeconds=0,totalPoints=0;
    for(let i=0;i<rows.length;i++){
      const result=validation.results[i];
      if(result.kind==='loop'){
        const iterations=result.loopIterations||1;
        stack.push({rowIndex:i+1,iterations,previousMultiplier:multiplier});
        multiplier*=iterations;
        if(!Number.isFinite(multiplier) || multiplier>Number.MAX_SAFE_INTEGER){
          setTimeScanRowWarning(rows[i],true);
          return {ok:false,error:`Command ${i+1}: loop nesting produces too many repetitions.`};
        }
        continue;
      }
      if(result.kind==='endloop'){
        const opened=stack.pop();
        if(!opened){
          setTimeScanRowWarning(rows[i],true);
          return {ok:false,error:`Command ${i+1}: endloop has no matching loop.`};
        }
        multiplier=opened.previousMultiplier;
        continue;
      }
      const effectiveSeconds=result.seconds*multiplier;
      const effectivePoints=result.points*multiplier;
      scans.push({row:rows[i],...result,loopMultiplier:multiplier,effectiveSeconds,effectivePoints});
      baseSeconds+=effectiveSeconds;
      totalPoints+=effectivePoints;
    }
    if(stack.length){
      const opened=stack[stack.length-1];
      setTimeScanRowWarning(rows[opened.rowIndex-1],true);
      return {ok:false,error:`Command ${opened.rowIndex}: loop has no matching endloop.`};
    }
    const movementSeconds=baseSeconds*settings.movementPercent/100;
    const totalSeconds=baseSeconds+movementSeconds;
    return {ok:true,rows,scans,baseSeconds,movementSeconds,totalSeconds,totalPoints,settings};
  };

  calculateTimeEstimate = function(){
    clearTimeEstimateMessage();
    const scanData=readAllTimeScans();
    if(!scanData.ok){ setTimeEstimateMessage(scanData.error,true); return; }
    const startResult=readTimeEstimateDate('Start','scan start time');
    if(!startResult.ok){ setTimeEstimateMessage(startResult.error,true); return; }
    const endExact=new Date(startResult.date.getTime()+scanData.totalSeconds*1000);
    writeTimeEstimateDate('End',ceilDateToMinute(endExact));
    saveTimeEstimateState();
    const movement=scanData.settings.movementPercent>0
      ? ` (base ${formatEstimatedDuration(scanData.baseSeconds)} + movement ${formatEstimatedDuration(scanData.movementSeconds)} at ${scanData.settings.movementPercent}%)`
      : '';
    setTimeEstimateMessage(`Estimated duration: ${formatEstimatedDuration(scanData.totalSeconds)}${movement} / ${scanData.totalPoints} execution step${scanData.totalPoints===1?'':'s'} in ${scanData.rows.length} command${scanData.rows.length===1?'':'s'}.`);
  };

  calculateTimeEstimateMcu = function(){
    clearTimeEstimateMessage();
    const scanData=readAllTimeScans();
    if(!scanData.ok){ setTimeEstimateMessage(scanData.error,true); return; }
    const startResult=validTimeEstimateDateInput('Start','scan start time');
    if(!startResult.ok){ setTimeEstimateMessage(startResult.error,true); return; }
    const endResult=validTimeEstimateDateInput('End','scan finish time');
    if(!endResult.ok){ setTimeEstimateMessage(endResult.error,true); return; }
    const targetSeconds=(endResult.date.getTime()-startResult.date.getTime())/1000;
    if(!(targetSeconds>0)){
      for(const input of [endResult.dateInput,endResult.hourInput,endResult.minuteInput]) setTimeInputInvalid(input,true);
      setTimeEstimateMessage('Scan finish must be later than scan start.',true);
      return;
    }

    const factor=scanData.settings.movementFactor;
    const targetBaseSeconds=targetSeconds/factor;
    const fixedScans=scanData.scans.filter(scan=>scan.fixed);
    const adjustableScans=scanData.scans.filter(scan=>!scan.fixed);
    const fixedSeconds=fixedScans.reduce((sum,scan)=>sum+scan.effectiveSeconds,0);
    const adjustableSeconds=adjustableScans.reduce((sum,scan)=>sum+scan.effectiveSeconds,0);
    const remainingBaseSeconds=targetBaseSeconds-fixedSeconds;
    const eps=1e-9;

    if(remainingBaseSeconds < -eps){
      const fixedWithMovement=fixedSeconds*factor;
      setTimeEstimateMessage(`Fixed commands plus movement overhead already require ${formatEstimatedDuration(fixedWithMovement)}, which exceeds the available ${formatEstimatedDuration(targetSeconds)}.`,true);
      return;
    }
    if(!adjustableScans.length){
      const difference=Math.abs(targetSeconds-scanData.totalSeconds);
      if(difference<=0.01) setTimeEstimateMessage('All adjustable scan MCU values are fixed. The current settings already match the requested finish time.');
      else setTimeEstimateMessage('There are no unfixed scan MCU values available to adjust.',true);
      return;
    }
    if(!(adjustableSeconds>0)){
      if(remainingBaseSeconds<=eps){
        for(const scan of adjustableScans){
          const input=scan.row.querySelector('[data-time-mcu]');
          if(input) input.value='0';
        }
        saveTimeEstimateState();
        setTimeEstimateMessage('Unfixed scan MCU values set to 0; fixed commands and movement overhead use the full available time.');
        return;
      }
      setTimeEstimateMessage('At least one unfixed scan MCU value must be greater than zero to use the entered MCU values as relative weights.',true);
      return;
    }

    const scale=Math.max(0,remainingBaseSeconds)/adjustableSeconds;
    for(const scan of adjustableScans){
      const input=scan.row.querySelector('[data-time-mcu]');
      if(!input) continue;
      input.value=formatScaledMcu((scan.mcuValue??scan.mcuSeconds)*scale);
      setTimeInputInvalid(input,false);
    }
    saveTimeEstimateState();
    const updated=readAllTimeScans();
    const actual=updated.ok?updated.totalSeconds:targetSeconds;
    const movementText=scanData.settings.movementPercent>0?` Movement overhead: ${scanData.settings.movementPercent}%.`:'';
    setTimeEstimateMessage(`Unfixed scan MCU values scaled by ×${Number(scale.toPrecision(6))}; ${fixedScans.length} fixed command${fixedScans.length===1?'':'s'} unchanged.${movementText} Target duration: ${formatEstimatedDuration(targetSeconds)}; calculated duration: ${formatEstimatedDuration(actual)}.`);
  };

  function v57PreviousSpiceLinesForCommand(commandIndex,oldMap,oldLines){
    const map=oldMap?.[commandIndex];
    if(!map || !(map.start>=1) || !(map.end>=map.start)) return [];
    return oldLines.slice(map.start-1,map.end);
  }
  function v57CommandNumberFromMessage(message){
    const match=/\bCommand\s+(\d+)\s*:/i.exec(String(message||''));
    return match?Number(match[1]):null;
  }
  function v57SpiceValidationSummary(validation){
    const messages=[];
    for(const error of validation?.errors||[]){
      const command=v57CommandNumberFromMessage(error);
      const line=command?v42SpiceLineMap[command-1]?.start:null;
      const detail=String(error).replace(/^Command\s+\d+\s*:\s*/i,'');
      messages.push(line?`Line ${line} (Command ${command}): ${detail}`:(command?`Command ${command}: ${detail}`:`Error: ${detail}`));
    }
    for(const warning of validation?.warnings||[]){
      const command=v57CommandNumberFromMessage(warning);
      const line=command?v42SpiceLineMap[command-1]?.start:null;
      const detail=String(warning).replace(/^Command\s+\d+\s*:\s*/i,'');
      messages.push(line?`Warning — Line ${line} (Command ${command}): ${detail}`:(command?`Warning — Command ${command}: ${detail}`:`Warning: ${detail}`));
    }
    return messages.join('\n');
  }

  // Generate a best-effort macro without replacing invalid commands with # ERROR
  // comments. Invalid/warning lines are identified only by the editor highlight;
  // their explanations are shown in scriptMessage below the editor.
  generateSpiceMacroFromTimeEstimate = function(){
    const validation=validateAllTimeScanRows({showMessage:true});
    const structure=ensureTimeLoopPairIds();
    const area=$('scriptSpiceText');
    const oldLines=String(area?.value??'').split('\n');
    const oldMap=v42SpiceLineMap.map(item=>item?{...item}:item);
    const lines=[];
    v42SpiceLineMap=[]; v42SpiceErrorLines=new Set(); v42SpiceWarningLines=new Set();
    const commandErrors=new Set((validation.errors||[]).map(v57CommandNumberFromMessage).filter(Number.isFinite));
    const commandWarnings=new Set((validation.warnings||[]).map(v57CommandNumberFromMessage).filter(Number.isFinite));

    for(let i=0;i<structure.rows.length;i++){
      const row=structure.rows[i];
      const result=validation.results[i];
      const info=structure.info.get(row);
      const command=row.querySelector('[data-time-variable]')?.value||result?.command||'drive:s1';
      const start=lines.length+1;
      let rowLines=[];
      if(!result?.ok) rowLines=v57PreviousSpiceLinesForCommand(i,oldMap,oldLines);
      if(!rowLines.length){
        try{
          rowLines=v42SpiceLinesForRow(row,info,result?.command?result:{...result,command});
        }catch(err){
          const message=`Command ${i+1}: ${err?.message||String(err)}`;
          if(!validation.errors.includes(message)) validation.errors.push(message);
          commandErrors.add(i+1);
          rowLines=v57PreviousSpiceLinesForCommand(i,oldMap,oldLines);
        }
      }
      if(!rowLines.length) rowLines=v57PreviousSpiceLinesForCommand(i,oldMap,oldLines);
      if(!rowLines.length) rowLines=[''];
      lines.push(...rowLines);
      const end=lines.length;
      v42SpiceLineMap[i]={start,end};
      if(!result?.ok || commandErrors.has(i+1)) for(let line=start;line<=end;line++) v42SpiceErrorLines.add(line);
      else if(commandWarnings.has(i+1)) for(let line=start;line<=end;line++) v42SpiceWarningLines.add(line);
    }
    validation.ok=validation.errors.length===0;
    v42LastSpiceValidation=validation;
    return lines.join('\n');
  };

  return {
    currentGeometryCardTab,
    hklInCurrentScatteringPlane,
    initializeScriptUI,
    initializeTimeEstimateUI,
    mountTimeEstimateForScript,
    scatteringPlaneWarningMessage,
    setGeometryCardTab,
    setScatteringPlaneWarning,
    validateAllTimeScanRows,
  };
}
