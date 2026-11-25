// Timer for music-player-sync.js while its page is hidden. Worker timers are
// not subject to Chrome's intensive throttling of background pages (one
// wake-up a minute after 5 minutes), so an idle player stays reachable.
var timer = null
onmessage = function(e) {
  clearTimeout(timer)
  if (e.data > 0) timer = setTimeout(function() { postMessage(0) }, e.data)
}
