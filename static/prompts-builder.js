;(function(){
  var STORAGE_KEY = 'onegy.prompt-builder.v1'
  var VERSION = 1
  var MAX_TEXT = 50000

  var TASK_LABELS = {
    build: 'Build or change a feature',
    fix: 'Fix a bug',
    diagnose: 'Diagnose an issue',
    review: 'Review code',
    security: 'Run a security audit',
    performance: 'Run a performance audit',
    refactor: 'Refactor code',
    tests: 'Add or improve tests',
    frontend: 'Work on frontend or UI',
    database: 'Work on a database or migration',
    research: 'Research and compare approaches',
    plan: 'Create an implementation plan',
    explain: 'Explain existing code',
    docs: 'Write documentation',
    delivery: 'Prepare a release or deployment',
    custom: 'Complete a custom task'
  }

  var MODES = {
    analyze: 'Analyze only. Do not modify files.',
    plan: 'Produce an implementation-ready plan. Do not modify files.',
    review: 'Review only. Do not modify files unless explicitly asked afterward.',
    implement: 'Implement the work end-to-end rather than stopping at advice or a proposed solution.'
  }

  var TASK_DEFAULTS = {
    build: {mode:'implement', runTests:true, runBuild:true},
    fix: {mode:'implement', autoDiagnose:true, skillDiagnosis:true, runTests:true, runBuild:true},
    diagnose: {mode:'analyze', autoDiagnose:true, skillDiagnosis:true, issueOnly:true, focusCorrectness:true, focusTests:true, fileEvidence:true, includeImpact:true, includeFix:true},
    review: {mode:'review', issueOnly:true, focusCorrectness:true, focusTests:true, ignoreStyle:true, fileEvidence:true, includeImpact:true, includeFix:true},
    security: {mode:'review', issueOnly:true, focusCorrectness:true, focusSecurity:true, focusTests:true, ignoreStyle:true, fileEvidence:true, includeImpact:true, includeFix:true, skillSecurity:true},
    performance: {mode:'review', issueOnly:true, focusPerformance:true, focusConcurrency:true, focusTests:true, ignoreStyle:true, fileEvidence:true, includeImpact:true, includeFix:true, skillPerformance:true},
    refactor: {mode:'implement', runTests:true, runFormat:true, runLint:true},
    tests: {mode:'implement', skillVerification:true, runTests:true},
    frontend: {mode:'implement', preserveDesign:true, responsive:true, accessibility:true, avoidGenericUi:true, skillFrontend:true, runTests:true, runBuild:true},
    database: {mode:'implement', migrationSafety:true, dataIntegrity:true, rollback:true, queryPerformance:true, skillDatabase:true, runTests:true},
    research: {mode:'analyze', gatherEvidence:true, compareOptions:true, identifyUnknowns:true, skillResearch:true},
    plan: {mode:'plan', gatherEvidence:true, compareOptions:true, implementationReady:true, identifyUnknowns:true, skillResearch:true, format:'plan'},
    explain: {mode:'analyze', inspectFirst:true},
    docs: {mode:'implement', runFormat:true},
    delivery: {mode:'implement', skillGit:true, runTests:true, runFormat:true, runLint:true, runBuild:true, deployCheck:true},
    custom: {mode:'implement'}
  }

  var AUTO_FIELDS = {}
  Object.keys(TASK_DEFAULTS).forEach(function(k){
    Object.keys(TASK_DEFAULTS[k]).forEach(function(f){ AUTO_FIELDS[f] = true })
  })

  var SKILL_PACKS = {
    skillDiagnosis: 'Use systematic diagnosis: reproduce, gather evidence, isolate the failing layer, test the hypothesis, then fix the cause rather than the symptom.',
    skillVerification: 'Use verification-before-completion: run the strongest relevant checks and report exact failures or limitations.',
    skillSecurity: 'Treat input validation, authorization, secrets, trust boundaries, and failure modes as first-class concerns.',
    skillPerformance: 'Measure or derive the bottleneck before optimizing, and consider CPU, memory, I/O, concurrency, and scale.',
    skillResearch: 'Ground recommendations in inspected evidence, compare alternatives, and make assumptions explicit.',
    skillGit: 'Keep the diff scoped, inspect existing changes, update affected documentation, and do not commit or push unless explicitly requested.',
    skillFrontend: 'Apply responsive, accessible frontend engineering while preserving the existing design system.',
    skillDatabase: 'Treat schema changes and data writes as production operations requiring integrity, bounded work, and recovery planning.'
  }

  var CAVEMAN_LEAD = {
    lite: 'Use lightly compressed prose: remove pleasantries, filler, and repetition while keeping complete sentences.',
    full: 'Use terse technical prose. Drop articles, filler, pleasantries, and hedging; fragments are acceptable. Preserve all technical substance, code, commands, API names, and exact errors.',
    ultra: 'Use ultra-compressed technical prose and fragments. Preserve every material fact, exact command, code block, API name, and error string.'
  }
  var CAVEMAN_TAIL = 'Do not invent abbreviations. Temporarily favor uncompressed clarity for security warnings, irreversible-action confirmations, or steps where compression could create ambiguity.'

  var BOOL_KEYS = [
    'inspectFirst','autoDiagnose','askWhenBlocked','persist','subagents','parallel',
    'smallestChange','preserveBehavior','avoidDeps','respectChanges',
    'issueOnly','focusCorrectness','focusTests','focusSecurity','focusPerformance','focusConcurrency','ignoreStyle','fileEvidence','includeImpact','includeFix',
    'preserveDesign','responsive','accessibility','avoidGenericUi',
    'migrationSafety','dataIntegrity','rollback','queryPerformance',
    'gatherEvidence','compareOptions','identifyUnknowns','implementationReady',
    'skillDiagnosis','skillVerification','skillSecurity','skillPerformance','skillResearch','skillGit','skillFrontend','skillDatabase',
    'runTests','runFormat','runLint','runBuild','deployCheck'
  ]
  var TEXT_KEYS = [
    'task','mode','objective','scope','baseBody','baseTitle',
    'observed','expected','reproduction','background','constraints','nonGoals','successCriteria',
    'customCommands','customInstructions','verbosity','format','caveman'
  ]

  function baseDraft(){
    var d = {
      version: VERSION,
      task: 'build',
      mode: 'implement',
      objective: '',
      scope: '',
      baseBody: '',
      baseTitle: '',
      observed: '', expected: '', reproduction: '',
      inspectFirst: true,
      autoDiagnose: false,
      askWhenBlocked: true,
      persist: true,
      subagents: false,
      parallel: true,
      smallestChange: true,
      preserveBehavior: true,
      avoidDeps: true,
      respectChanges: true,
      issueOnly: false,
      focusCorrectness: false,
      focusTests: false,
      focusSecurity: false,
      focusPerformance: false,
      focusConcurrency: false,
      ignoreStyle: false,
      fileEvidence: false,
      includeImpact: false,
      includeFix: false,
      preserveDesign: false,
      responsive: false,
      accessibility: false,
      avoidGenericUi: false,
      migrationSafety: false,
      dataIntegrity: false,
      rollback: false,
      queryPerformance: false,
      gatherEvidence: false,
      compareOptions: false,
      identifyUnknowns: false,
      implementationReady: false,
      skillDiagnosis: false,
      skillVerification: false,
      skillSecurity: false,
      skillPerformance: false,
      skillResearch: false,
      skillGit: false,
      skillFrontend: false,
      skillDatabase: false,
      background: '',
      constraints: '',
      nonGoals: '',
      successCriteria: '',
      runTests: false,
      runFormat: false,
      runLint: false,
      runBuild: false,
      deployCheck: false,
      customCommands: '',
      verbosity: '',
      format: '',
      caveman: '',
      customInstructions: '',
      touched: {}
    }
    applyDefaults(d, 'build', true)
    return d
  }

  function clampText(v){
    v = v == null ? '' : String(v)
    return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v
  }

  function trim(v){
    return clampText(v).replace(/^\s+|\s+$/g, '')
  }

  function applyDefaults(d, task, force){
    var defs = TASK_DEFAULTS[task] || {}
    Object.keys(defs).forEach(function(k){
      if(force || !(d.touched && d.touched[k])) d[k] = defs[k]
    })
  }

  function composePrompt(draft){
    var d = draft || {}
    var sections = []
    var label = TASK_LABELS[d.task] || d.task || 'Custom'
    sections.push('Task type: ' + label)

    var obj = trim(d.objective)
    sections.push('Objective\n' + (obj || 'No objective provided yet.'))

    if(trim(d.scope)) sections.push('Target or scope\n' + trim(d.scope))

    var action = MODES[d.mode] || MODES.implement
    sections.push('Action\n' + action)

    if(trim(d.baseBody)){
      var bt = trim(d.baseTitle)
      sections.push((bt ? 'Base prompt: ' + bt : 'Base prompt') + '\n' + trim(d.baseBody))
    }

    if(d.task === 'fix' || d.task === 'diagnose'){
      var bug = []
      if(trim(d.observed)) bug.push('Observed: ' + trim(d.observed))
      if(trim(d.expected)) bug.push('Expected: ' + trim(d.expected))
      if(trim(d.reproduction)) bug.push('Reproduction: ' + trim(d.reproduction))
      if(bug.length) sections.push('Bug details\n' + bug.join('\n'))
    }

    var wf = []
    if(d.inspectFirst) wf.push('Inspect the relevant code and existing patterns before proposing or changing anything.')
    if(d.autoDiagnose) wf.push('Diagnose the root cause before implementing a fix.')
    if(d.askWhenBlocked) wf.push('If blocked, ask a clarifying question instead of guessing.')
    if(d.persist) wf.push('Keep going until the task is complete or you are genuinely blocked.')
    if(d.subagents) wf.push('Use subagents to explore in parallel when that helps.')
    if(d.parallel) wf.push('Prefer parallel tool calls when gathering context.')
    if(wf.length) sections.push('Workflow\n' + wf.join('\n'))

    if(d.mode === 'implement'){
      var ic = []
      if(d.smallestChange) ic.push('Make the smallest change that accomplishes the objective.')
      if(d.preserveBehavior) ic.push('Preserve existing behavior unless the objective requires otherwise.')
      if(d.avoidDeps) ic.push('Avoid adding dependencies unless they are necessary.')
      if(d.respectChanges) ic.push('Respect existing uncommitted changes; do not revert unrelated work.')
      if(ic.length) sections.push('Implementation constraints\n' + ic.join('\n'))
    }

    if(['review','security','performance','diagnose'].indexOf(d.task) >= 0){
      var fr = []
      if(d.issueOnly) fr.push('Report only real issues. Do not praise working code or restate what it does.')
      if(d.focusCorrectness) fr.push('Prioritize correctness bugs.')
      if(d.focusTests) fr.push('Prioritize missing or weak tests.')
      if(d.focusSecurity) fr.push('Prioritize security issues.')
      if(d.focusPerformance) fr.push('Prioritize performance issues.')
      if(d.focusConcurrency) fr.push('Prioritize concurrency and race issues.')
      if(d.ignoreStyle) fr.push('Ignore style nits a linter would catch.')
      if(d.fileEvidence) fr.push('Cite file and line for every finding.')
      if(d.includeImpact) fr.push('State the impact if left as-is.')
      if(d.includeFix) fr.push('Give a concrete fix for each finding.')
      if(fr.length) sections.push('Finding requirements\n' + fr.join('\n'))
    }

    if(d.task === 'frontend'){
      var fe = []
      if(d.preserveDesign) fe.push('Preserve the existing design system and visual language.')
      if(d.responsive) fe.push('Layout must work across the project breakpoints.')
      if(d.accessibility) fe.push('Meet keyboard and screen-reader requirements.')
      if(d.avoidGenericUi) fe.push('Do not introduce generic or off-brand UI.')
      if(fe.length) sections.push('Frontend requirements\n' + fe.join('\n'))
    }

    if(d.task === 'database'){
      var db = []
      if(d.migrationSafety) db.push('Treat schema changes as additive and production-safe.')
      if(d.dataIntegrity) db.push('Preserve data integrity; no silent corruption.')
      if(d.rollback) db.push('Plan rollback for any destructive step.')
      if(d.queryPerformance) db.push('Watch for N+1 queries, missing indexes, and unbounded reads.')
      if(db.length) sections.push('Database requirements\n' + db.join('\n'))
    }

    if(d.task === 'research' || d.task === 'plan'){
      var rs = []
      if(d.gatherEvidence) rs.push('Ground recommendations in inspected evidence.')
      if(d.compareOptions) rs.push('Compare alternatives explicitly.')
      if(d.identifyUnknowns) rs.push('Call out unknowns and assumptions.')
      if(d.implementationReady) rs.push('Produce an implementation-ready plan.')
      if(rs.length) sections.push('Research requirements\n' + rs.join('\n'))
    }

    var packs = []
    Object.keys(SKILL_PACKS).forEach(function(k){ if(d[k]) packs.push(SKILL_PACKS[k]) })
    if(packs.length) sections.push('Instruction packs\n' + packs.join('\n'))

    if(trim(d.background)) sections.push('Background and evidence\n' + trim(d.background))
    if(trim(d.constraints)) sections.push('Additional constraints\n' + trim(d.constraints))
    if(trim(d.nonGoals)) sections.push('Non-goals\n' + trim(d.nonGoals))
    if(trim(d.successCriteria)) sections.push('Success criteria\n' + trim(d.successCriteria))

    var ver = []
    if(d.runTests) ver.push('Run the relevant tests.')
    if(d.runFormat) ver.push('Run the formatter.')
    if(d.runLint) ver.push('Run the linter.')
    if(d.runBuild) ver.push('Run the build.')
    if(d.deployCheck) ver.push('Verify deploy and release checks.')
    if(trim(d.customCommands)) ver.push('Run:\n' + trim(d.customCommands))
    if(ver.length) sections.push('Verification\n' + ver.join('\n'))

    var resp = []
    if(d.verbosity === 'concise') resp.push('Keep the response concise.')
    if(d.verbosity === 'detailed') resp.push('Be thorough; do not omit material detail.')
    if(d.format === 'plan') resp.push('Structure the response as an implementation plan.')
    if(d.format === 'checklist') resp.push('Structure the response as a checklist.')
    if(d.format === 'pr') resp.push('Structure the response as a pull-request review.')
    if(resp.length) sections.push('Response requirements\n' + resp.join('\n'))

    if(d.caveman && CAVEMAN_LEAD[d.caveman]){
      sections.push('Communication mode: Caveman ' + d.caveman + '\n' + CAVEMAN_LEAD[d.caveman] + ' ' + CAVEMAN_TAIL)
    }

    if(trim(d.customInstructions)) sections.push('Custom instructions\n' + trim(d.customInstructions))

    return sections.join('\n\n')
  }

  function canCopy(d){
    return !!(trim(d.objective) || trim(d.baseBody))
  }

  function loadStored(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY)
      if(!raw) return null
      var parsed = JSON.parse(raw)
      if(!parsed || typeof parsed !== 'object') return null
      var d = baseDraft()
      TEXT_KEYS.forEach(function(k){ if(typeof parsed[k] === 'string') d[k] = clampText(parsed[k]) })
      BOOL_KEYS.forEach(function(k){ if(typeof parsed[k] === 'boolean') d[k] = parsed[k] })
      d.touched = parsed.touched && typeof parsed.touched === 'object' ? parsed.touched : {}
      if(!TASK_LABELS[d.task]) d.task = 'build'
      if(!MODES[d.mode]) d.mode = 'implement'
      return d
    }catch(e){ return null }
  }

  function saveStored(d){
    try{
      var out = {version: VERSION, touched: d.touched || {}}
      TEXT_KEYS.forEach(function(k){ out[k] = clampText(d[k]) })
      BOOL_KEYS.forEach(function(k){ out[k] = !!d[k] })
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
    }catch(e){}
  }

  function inferTask(prompt, category){
    var tags = (prompt && prompt.tags) || []
    var cat = (category && category.id) || ''
    var blob = (tags.join(' ') + ' ' + cat).toLowerCase()
    if(blob.indexOf('security') >= 0) return 'security'
    if(blob.indexOf('performance') >= 0) return 'performance'
    if(blob.indexOf('frontend') >= 0) return 'frontend'
    if(blob.indexOf('testing') >= 0) return 'tests'
    if(blob.indexOf('review') >= 0) return 'review'
    if(blob.indexOf('explain') >= 0 || blob.indexOf('documentation') >= 0) return 'explain'
    if(blob.indexOf('delivery') >= 0) return 'delivery'
    if(blob.indexOf('architecture') >= 0 || blob.indexOf('planning') >= 0) return 'plan'
    if(blob.indexOf('database') >= 0) return 'database'
    if(blob.indexOf('refactor') >= 0) return 'refactor'
    return prompt && prompt.makes_changes ? 'build' : 'diagnose'
  }

  var draft = baseDraft()
  var form = null
  var preview = null
  var copyBtn = null
  var dlBtn = null
  var statusEl = null
  var seedEl = null
  var seedTitle = null

  function $(id){ return document.getElementById(id) }

  function fieldEls(){
    return form ? form.querySelectorAll('[data-pr]') : []
  }

  function readForm(){
    fieldEls().forEach(function(el){
      var k = el.getAttribute('data-pr')
      if(!k) return
      if(el.type === 'checkbox') draft[k] = el.checked
      else draft[k] = clampText(el.value)
    })
  }

  function writeForm(){
    fieldEls().forEach(function(el){
      var k = el.getAttribute('data-pr')
      if(!k) return
      if(el.type === 'checkbox') el.checked = !!draft[k]
      else el.value = draft[k] == null ? '' : String(draft[k])
    })
  }

  function showGroups(){
    var task = draft.task
    var mode = draft.mode
    document.querySelectorAll('[data-pr-show]').forEach(function(el){
      var ok = el.getAttribute('data-pr-show').split(',').indexOf(task) >= 0
      el.hidden = !ok
    })
    document.querySelectorAll('[data-pr-mode]').forEach(function(el){
      el.hidden = el.getAttribute('data-pr-mode') !== mode
    })
    if(seedEl){
      var seeded = !!trim(draft.baseBody)
      seedEl.hidden = !seeded
      if(seedTitle) seedTitle.textContent = trim(draft.baseTitle) || 'Library prompt'
    }
  }

  function refreshPreview(){
    var text = composePrompt(draft)
    if(preview) preview.textContent = text
    var ok = canCopy(draft)
    if(copyBtn) copyBtn.disabled = !ok
    if(dlBtn) dlBtn.disabled = !ok
  }

  function persist(){
    saveStored(draft)
    refreshPreview()
  }

  function setStatus(msg){
    if(!statusEl) return
    statusEl.textContent = msg || ''
    if(msg) setTimeout(function(){ if(statusEl.textContent === msg) statusEl.textContent = '' }, 2200)
  }

  function switchTab(name){
    var lib = $('prLibrary')
    var bld = $('prBuilder')
    var tLib = $('prTabLibrary')
    var tBld = $('prTabBuilder')
    var isB = name === 'builder'
    if(lib) lib.hidden = isB
    if(bld) bld.hidden = !isB
    if(tLib) tLib.setAttribute('aria-selected', isB ? 'false' : 'true')
    if(tBld) tBld.setAttribute('aria-selected', isB ? 'true' : 'false')
    try{
      if(isB) history.replaceState(null, '', '#builder')
      else if(location.hash === '#builder') history.replaceState(null, '', location.pathname + location.search)
    }catch(e){}
  }

  function seedFromLibrary(prompt, category){
    var task = inferTask(prompt, category)
    draft = baseDraft()
    draft.task = task
    applyDefaults(draft, task, true)
    draft.objective = prompt.title || ''
    draft.baseBody = prompt.body || ''
    draft.baseTitle = prompt.title || ''
    draft.background = prompt.blurb || ''
    draft.touched = {objective:true, baseBody:true, baseTitle:true, background:true, task:true}
    writeForm()
    showGroups()
    persist()
    switchTab('builder')
    setStatus('Seeded from library')
  }

  function copyText(text){
    if(navigator.clipboard && navigator.clipboard.writeText){
      return navigator.clipboard.writeText(text)
    }
    return new Promise(function(resolve, reject){
      var ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly','')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      try{
        document.execCommand('copy') ? resolve() : reject()
      }catch(e){ reject(e) }
      document.body.removeChild(ta)
    })
  }

  function bind(){
    form = $('prForm')
    preview = $('prPreview')
    copyBtn = $('prCopy')
    dlBtn = $('prDownload')
    statusEl = $('prStatus')
    seedEl = $('prSeed')
    seedTitle = $('prSeedTitle')
    if(!form) return

    var stored = loadStored()
    if(stored) draft = stored
    writeForm()
    showGroups()
    refreshPreview()

    form.addEventListener('input', onChange)
    form.addEventListener('change', onChange)

    var restore = $('prRestore')
    if(restore) restore.addEventListener('click', function(){
      applyDefaults(draft, draft.task, true)
      Object.keys(TASK_DEFAULTS[draft.task] || {}).forEach(function(k){
        if(draft.touched) delete draft.touched[k]
      })
      writeForm()
      showGroups()
      persist()
      setStatus('Restored recommended options')
    })

    var reset = $('prReset')
    if(reset) reset.addEventListener('click', function(){
      draft = baseDraft()
      writeForm()
      showGroups()
      persist()
      setStatus('Reset')
    })

    var seedClear = $('prSeedClear')
    if(seedClear) seedClear.addEventListener('click', function(){
      draft.baseBody = ''
      draft.baseTitle = ''
      if(draft.touched){ delete draft.touched.baseBody; delete draft.touched.baseTitle }
      showGroups()
      persist()
    })

    if(copyBtn) copyBtn.addEventListener('click', function(){
      copyText(composePrompt(draft)).then(function(){ setStatus('Copied') }).catch(function(){ setStatus('Copy failed') })
    })

    if(dlBtn) dlBtn.addEventListener('click', function(){
      var blob = new Blob([composePrompt(draft)], {type:'text/plain;charset=utf-8'})
      var a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'onegy-prompt.txt'
      document.body.appendChild(a)
      a.click()
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove() }, 0)
    })

    document.querySelectorAll('[data-pr-tab]').forEach(function(btn){
      btn.addEventListener('click', function(){ switchTab(btn.getAttribute('data-pr-tab')) })
    })

    if(location.hash === '#builder') switchTab('builder')
  }

  function onChange(e){
    var el = e.target
    if(!el || !el.getAttribute) return
    var k = el.getAttribute('data-pr')
    if(!k) return
    var prevTask = draft.task
    if(el.type === 'checkbox') draft[k] = el.checked
    else draft[k] = clampText(el.value)
    if(!draft.touched) draft.touched = {}
    draft.touched[k] = true
    if(k === 'task' && draft.task !== prevTask){
      applyDefaults(draft, draft.task, false)
      writeForm()
    }
    showGroups()
    persist()
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind)
  else bind()

  window.PromptBuilder = {
    composePrompt: composePrompt,
    seedFromLibrary: seedFromLibrary,
    switchTab: switchTab,
    copyText: copyText,
    canCopy: canCopy,
    getDraft: function(){ return draft }
  }
})()
