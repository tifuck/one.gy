;(function(){
  var catalog = {total:0, tags:[], categories:[]}
  var byId = {}
  var activeTags = {}
  var hideInput = false
  var conciseMode = true
  var query = ''
  var openId = ''
  var pageReady = Date.now()
  var humanInteracted = false
  var fbKind = 'general'
  var fbPromptId = ''

  ;['pointerdown','keydown','mousemove','touchstart'].forEach(function(t){
    window.addEventListener(t, function mark(){ humanInteracted = true; window.removeEventListener(t, mark) }, {once:true, passive:true})
  })

  function $(id){ return document.getElementById(id) }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
    })
  }

  function matches(p, cat){
    if(hideInput && p.needs_input) return false
    var tagKeys = Object.keys(activeTags)
    if(tagKeys.length){
      var ok = false
      for(var i=0;i<(p.tags||[]).length;i++) if(activeTags[p.tags[i]]){ ok = true; break }
      if(!ok) return false
    }
    if(query){
      var blob = ((p.title||'')+' '+(p.blurb||'')+' '+(p.summary||'')+' '+(p.tags||[]).join(' ')+' '+(cat.name||'')).toLowerCase()
      if(blob.indexOf(query) < 0) return false
    }
    return true
  }

  function render(){
    var listEl = $('prList')
    var tagsEl = $('prTags')
    if(!listEl) return

    if(tagsEl){
      if(!(catalog.tags||[]).length) tagsEl.hidden = true
      else {
        tagsEl.hidden = false
        tagsEl.innerHTML = catalog.tags.map(function(t){
          return '<button type="button" class="pr-chip'+(activeTags[t]?' is-on':'')+'" data-tag="'+esc(t)+'">'+esc(t)+'</button>'
        }).join('')
      }
    }

    var html = ''
    var shown = 0
    var idx = 0
    catalog.categories.forEach(function(c){
      var rows = (c.prompts||[]).filter(function(p){ return matches(p, c) })
      if(!rows.length) return
      html += '<section class="pr-sec" id="pr-cat-'+esc(c.id)+'"><div class="pr-sec-head"><h2 class="pr-sec-title">'+esc(c.name)+'</h2></div>'
      html += '<p class="pr-sec-blurb">'+esc(c.blurb||'')+'</p>'
      rows.forEach(function(p){
        shown++
        html += '<div class="pr-row" data-id="'+esc(p.id)+'" role="button" tabindex="0" style="--i:'+(idx++)+'">'
        html += '<div><h3 class="pr-row-title">'+esc(p.title)+'</h3><p class="pr-row-blurb">'+esc(p.blurb||'')+'</p>'
        html += '<div class="pr-row-meta">'
        ;(p.tags||[]).forEach(function(t){ html += '<span class="pr-flag">'+esc(t)+'</span>' })
        if(p.makes_changes) html += '<span class="pr-flag pr-flag-edit">Edits</span>'
        if(p.needs_input) html += '<span class="pr-flag pr-flag-input">Needs input</span>'
        html += '</div></div>'
        html += '<button type="button" class="pr-row-copy" data-copy="'+esc(p.id)+'">Copy</button>'
        html += '</div>'
      })
      html += '</section>'
    })
    if(!shown) html = '<div class="pr-empty">No prompts match these filters.</div>'
    listEl.innerHTML = html
  }

  function openModal(id){
    var found = byId[id]
    if(!found) return
    var p = found.prompt
    var modal = $('prModal')
    $('prModalTitle').textContent = p.title || ''
    $('prModalBlurb').textContent = p.blurb || ''
    $('prModalSummary').textContent = p.summary || ''
    var flags = $('prModalFlags')
    var fh = ''
    ;(p.tags||[]).forEach(function(t){ fh += '<span class="pr-flag">'+esc(t)+'</span>' })
    if(p.makes_changes) fh += '<span class="pr-flag pr-flag-edit">Edits files</span>'
    if(p.needs_input) fh += '<span class="pr-flag pr-flag-input">Needs input</span>'
    flags.innerHTML = fh
    $('prModalBody').textContent = preparePrompt(p.body)
    openId = id
    modal.classList.add('rd-open')
    modal.setAttribute('aria-hidden', 'false')
    try{ history.replaceState(null, '', '#p/'+encodeURIComponent(id)) }catch(e){}
  }

  function closeModal(){
    var modal = $('prModal')
    if(!modal) return
    modal.classList.remove('rd-open')
    modal.setAttribute('aria-hidden', 'true')
    openId = ''
    try{
      if(/^#p\//.test(location.hash)) history.replaceState(null, '', location.pathname + location.search)
    }catch(e){}
  }

  function copyPrompt(id, btn){
    var found = byId[id]
    if(!found || !window.PromptBuilder) return
    window.PromptBuilder.copyText(preparePrompt(found.prompt.body)).then(function(){
      if(btn){ var old = btn.textContent; btn.textContent = 'Copied'; setTimeout(function(){ btn.textContent = old }, 1400) }
      else if(typeof showToast === 'function') showToast('Copied', 'success')
    }).catch(function(){
      if(typeof showToast === 'function') showToast('Copy failed', 'error')
    })
  }

  function preparePrompt(body){
    var text = (body || '')
      .replace(/Be concise and actionable\.\s*/g, '')
      .replace(/Be concise:\s*/g, '')
    if(!conciseMode) return text
    var requirement = 'Response requirement\nUse as few words as possible while communicating clearly. Omit no material details. Remove preambles, pleasantries, filler, repetition, and unnecessary transitions. Prefer short, direct sentences or fragments.\n\nExamples\n- Instead of “I have completed the requested change,” write “Implemented the change.”\n- Instead of “There are three issues that need attention,” write “3 issues:”\n- Instead of “You may want to consider using X because it is faster,” write “Use X; it is faster.”'
    var findings = /findings only, no preamble, no recap of working code\./i
    if(findings.test(text)) return text.replace(findings, requirement + '\nFindings only, no preamble, no recap of working code.')
    var finalConstraint = '\n\nDo not modify files until I explicitly grant permission.'
    if(text.indexOf(finalConstraint) >= 0) return text.replace(finalConstraint, '\n\n' + requirement + finalConstraint)
    return text.replace(/\s+$/, '') + '\n\n' + requirement
  }

  function loadOptions(){
    try{
      var saved = localStorage.getItem('onegy.prompt-options.concise')
      conciseMode = saved === null ? true : saved === 'true'
    }catch(e){}
    var concise = $('prConciseMode')
    if(concise) concise.checked = conciseMode
  }

  function detectAutomation(){
    var s = {interacted: humanInteracted}
    try { s.webdriver = navigator.webdriver === true } catch(e){ s.webdriver = false }
    try { s.ua = navigator.userAgent || '' } catch(e){ s.ua = '' }
    s.headlessUA = /headlesschrome|phantomjs|slimerjs/i.test(s.ua)
    s.blocked = s.webdriver === true || s.headlessUA === true
    return s
  }

  function csrf(){
    var m = document.querySelector('meta[name="csrf-token"]')
    return m ? m.getAttribute('content') : ''
  }

  function openFeedback(kind, promptId){
    fbKind = kind === 'prompt' ? 'prompt' : 'general'
    fbPromptId = promptId || ''
    var modal = $('prFbModal')
    var title = $('prFbTitle')
    var lead = $('prFbLead')
    var msg = $('prFbMessage')
    var status = $('prFbStatus')
    if(!modal) return
    if(title) title.textContent = 'Submit feedback'
    if(lead){
      if(fbKind === 'prompt'){
        var found = byId[fbPromptId]
        var name = found && found.prompt ? found.prompt.title : 'this prompt'
        lead.textContent = 'About “' + name + '”. Say what doesn’t make sense, what you’d add, or that you don’t like it.'
      } else {
        lead.textContent = 'About the prompts page as a whole — what’s useful, confusing, or missing.'
      }
    }
    if(msg){ msg.value = ''; msg.placeholder = fbKind === 'prompt' ? 'This part doesn’t make sense…' : 'What’s working, what’s confusing…' }
    if(status) status.textContent = ''
    modal.classList.add('rd-open')
    modal.setAttribute('aria-hidden', 'false')
    if(msg) setTimeout(function(){ msg.focus() }, 50)
  }

  function closeFeedback(){
    var modal = $('prFbModal')
    if(!modal) return
    modal.classList.remove('rd-open')
    modal.setAttribute('aria-hidden', 'true')
  }

  function submitFeedback(e){
    e.preventDefault()
    var msgEl = $('prFbMessage')
    var status = $('prFbStatus')
    var btn = $('prFbSubmit')
    var message = msgEl ? msgEl.value.trim() : ''
    var hp = document.querySelector('#prFbForm [name="website"]')
    var sig = detectAutomation()
    if(status) status.textContent = ''
    if(message.length < 8){
      if(status) status.textContent = 'Write a little more.'
      return
    }
    if(sig.blocked){
      if(status) status.textContent = 'Could not send feedback.'
      return
    }
    var body = {
      kind: fbKind,
      prompt_id: fbKind === 'prompt' ? fbPromptId : '',
      message: message,
      website: hp ? hp.value : '',
      dwell_ms: Date.now() - pageReady,
      signals: {webdriver: sig.webdriver, headlessUA: sig.headlessUA, interacted: sig.interacted}
    }
    if(btn) btn.disabled = true
    fetch('/prompts/feedback', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf(),
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(body)
    }).then(function(r){
      return r.json().then(function(d){ return {ok: r.ok, status: r.status, data: d} }).catch(function(){ return {ok: r.ok, status: r.status, data: {}} })
    }).then(function(res){
      if(btn) btn.disabled = false
      if(res.ok){
        if(status) status.textContent = 'Sent. Thank you.'
        if(msgEl) msgEl.value = ''
        setTimeout(closeFeedback, 900)
        return
      }
      var err = (res.data && res.data.error) || (res.status === 429 ? 'Too many submissions. Try again later.' : 'Could not send feedback.')
      if(status) status.textContent = err
    }).catch(function(){
      if(btn) btn.disabled = false
      if(status) status.textContent = 'Could not send feedback.'
    })
  }

  function bind(){
    var search = $('prSearch')
    if(search) search.addEventListener('input', function(){ query = (search.value||'').trim().toLowerCase(); render() })
    var hide = $('prHideInput')
    if(hide) hide.addEventListener('change', function(){ hideInput = hide.checked; render() })
    var concise = $('prConciseMode')
    if(concise) concise.addEventListener('change', function(){
      conciseMode = concise.checked
      try{ localStorage.setItem('onegy.prompt-options.concise', conciseMode ? 'true' : 'false') }catch(e){}
      if(openId){
        var found = byId[openId]
        if(found) $('prModalBody').textContent = preparePrompt(found.prompt.body)
      }
    })

    document.addEventListener('click', function(e){
      var tagBtn = e.target.closest('[data-tag]')
      if(tagBtn && tagBtn.closest('#prTags')){
        var t = tagBtn.getAttribute('data-tag')
        if(activeTags[t]) delete activeTags[t]
        else activeTags[t] = true
        render()
        return
      }
      var copyBtn = e.target.closest('[data-copy]')
      if(copyBtn){
        e.preventDefault()
        e.stopPropagation()
        copyPrompt(copyBtn.getAttribute('data-copy'), copyBtn)
        return
      }
      var row = e.target.closest('.pr-row[data-id]')
      if(row){ openModal(row.getAttribute('data-id')); return }
      if(e.target.closest('[data-pr-fb-close]')){ closeFeedback(); return }
      if(e.target.closest('[data-pr-modal-close]')) closeModal()
    })

    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){
        if($('prFbModal') && $('prFbModal').classList.contains('rd-open')) closeFeedback()
        else closeModal()
      }
      var row = e.target.closest && e.target.closest('.pr-row[data-id]')
      if(row && (e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-copy]')){
        e.preventDefault()
        openModal(row.getAttribute('data-id'))
      }
    })

    var mCopy = $('prModalCopy')
    if(mCopy) mCopy.addEventListener('click', function(){ if(openId) copyPrompt(openId, mCopy) })
    var mLink = $('prModalLink')
    if(mLink) mLink.addEventListener('click', function(){
      if(!openId) return
      var url = location.origin + location.pathname + '#p/' + encodeURIComponent(openId)
      if(window.PromptBuilder) window.PromptBuilder.copyText(url).then(function(){
        var old = mLink.textContent; mLink.textContent = 'Copied'; setTimeout(function(){ mLink.textContent = old }, 1400)
      })
    })
    var mCust = $('prModalCustomize')
    if(mCust) mCust.addEventListener('click', function(){
      var found = byId[openId]
      if(!found || !window.PromptBuilder) return
      closeModal()
      window.PromptBuilder.seedFromLibrary(found.prompt, found.category)
    })
    var mFb = $('prModalFeedback')
    if(mFb) mFb.addEventListener('click', function(){ openFeedback('prompt', openId) })
    var gFb = $('prFbGeneral')
    if(gFb) gFb.addEventListener('click', function(){ openFeedback('general', '') })
    var fbForm = $('prFbForm')
    if(fbForm) fbForm.addEventListener('submit', submitFeedback)
  }

  function indexCatalog(data){
    catalog = data || {total:0, tags:[], categories:[]}
    byId = {}
    ;(catalog.categories||[]).forEach(function(c){
      ;(c.prompts||[]).forEach(function(p){ byId[p.id] = {prompt:p, category:c} })
    })
  }

  function bootFromHash(){
    var h = location.hash || ''
    if(h === '#builder' && window.PromptBuilder) window.PromptBuilder.switchTab('builder')
    var m = h.match(/^#p\/(.+)$/)
    if(m) openModal(decodeURIComponent(m[1]))
  }

  function init(){
    loadOptions()
    bind()
    fetch('/prompts/catalog', {credentials:'same-origin', headers:{'X-Requested-With':'XMLHttpRequest'}})
      .then(function(r){ if(!r.ok) throw new Error('catalog'); return r.json() })
      .then(function(data){
        indexCatalog(data)
        render()
        bootFromHash()
      })
      .catch(function(){
        var list = $('prList')
        if(list) list.innerHTML = '<div class="pr-empty">Could not load the prompt catalog.</div>'
      })
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
