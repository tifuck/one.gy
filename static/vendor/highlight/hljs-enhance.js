/**
 * highlight.js Enhancement Plugin
 * Post-processes hljs output for bash/shell to colorize common patterns
 * that the built-in grammar misses (commands, flags, URLs, operators).
 * Uses existing hljs CSS classes so no theme changes needed.
 */
(function() {
  if (typeof hljs === 'undefined') return

  // Common shell commands (external programs + builtins not caught by hljs grammar)
  var cmdPattern = new RegExp(
    '\\b(' +
    // Unix core
    'alias|awk|base64|bash|bg|cat|cd|chmod|chown|chroot|cp|crontab|curl|cut|' +
    'dash|dd|df|diff|dig|dirname|du|echo|env|eval|exec|exit|export|false|' +
    'fg|file|find|fish|fmt|fold|ftp|grep|gzip|gunzip|head|hostname|htop|' +
    'id|ifconfig|install|ip|iptables|jobs|join|jq|kill|killall|less|ln|' +
    'locale|ls|lsof|make|man|md5sum|mkdir|mktemp|more|mount|mv|nano|nc|' +
    'netstat|nice|nl|nmap|nohup|nslookup|od|openssl|passwd|paste|patch|' +
    'pgrep|ping|pkill|popd|printf|ps|pushd|pwd|read|readlink|realpath|' +
    'reboot|rename|return|rm|rmdir|rsync|scp|sed|seq|service|set|sftp|' +
    'sh|sha256sum|shutdown|sleep|sort|source|split|ssh|stat|strace|' +
    'su|sudo|systemctl|journalctl|tac|tail|tar|tee|test|time|timeout|' +
    'top|touch|tr|traceroute|trap|true|type|ufw|umask|umount|unalias|' +
    'uname|uniq|unset|unzip|uptime|vim|vi|watch|wc|wget|which|' +
    'whereis|whoami|xargs|yes|zip|zsh|' +
    // Dev tools
    'ansible|aws|az|brew|cargo|cmake|composer|deno|docker|dotnet|' +
    'ffmpeg|flutter|gcc|gcloud|gh|git|go|gradle|helm|java|javac|' +
    'kubectl|lerna|magick|mvn|nginx|node|npm|npx|nvm|pip|pip3|' +
    'pipenv|pnpm|podman|poetry|python|python3|ruby|rustc|rustup|' +
    'sass|scala|swift|terraform|tsc|turbo|vagrant|vite|volta|' +
    'webpack|yarn|zig|' +
    // Windows / PowerShell
    'bitsadmin|certutil|choco|cls|cmd|copy|del|dir|icacls|iex|ipconfig|' +
    'irm|md|move|msiexec|net|powershell|pwsh|rd|reg|ren|runas|sc|' +
    'scoop|set|setx|systeminfo|taskkill|tasklist|winget|wmic|wsl|xcopy' +
    ')\\b', 'g'
  )

  // Flag pattern: -x, -fsSL, --output, --no-check (must follow whitespace, start-of-string, or pipe)
  var flagPattern = /(?<=\s|^|\|)(--?[a-zA-Z][\w-]*)/g

  // URL pattern
  var urlPattern = /(https?:\/\/[^\s<&]+)/g

  // Pipe/logic operators: |, ||, &&
  // Note: && is HTML-escaped as &amp;&amp; by hljs
  var operatorPattern = /(\|{1,2}|&amp;&amp;)/g

  // Environment variable assignments: ALL_CAPS=value
  var envVarPattern = /\b([A-Z_][A-Z0-9_]{1,})=/g

  /**
   * Apply a regex replacement only to text segments outside <span> tags.
   * This ensures each enhancement pass doesn't modify text already wrapped
   * by hljs or by a previous enhancement pass.
   */
  function applyOutsideSpans(html, regex, replacer) {
    var parts = html.split(/(<span[^>]*>|<\/span>)/)
    var depth = 0
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i]
      if (!p) continue
      if (p.indexOf('<span') === 0) { depth++; continue }
      if (p === '</span>') { depth = Math.max(0, depth - 1); continue }
      if (depth === 0) {
        // Reset lastIndex for global regexes before each use
        regex.lastIndex = 0
        parts[i] = p.replace(regex, replacer)
      }
    }
    return parts.join('')
  }

  function enhanceBashHtml(html) {
    // Split HTML into segments: tagged (inside <span>) and untagged (plain text)
    // We only enhance plain text segments that hljs left untouched
    var parts = html.split(/(<span[^>]*>|<\/span>)/)
    var depth = 0
    var result = []

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i]
      if (!part) { result.push(part); continue }

      if (part.indexOf('<span') === 0) {
        depth++
        result.push(part)
      } else if (part === '</span>') {
        depth = Math.max(0, depth - 1)
        result.push(part)
      } else if (depth > 0) {
        // Inside an existing hljs span — don't touch
        result.push(part)
      } else {
        // Plain text outside any span — enhance it
        // Each pass only modifies text outside spans created by previous passes
        var enhanced = part

        // 1. URLs first (most specific, longest matches)
        enhanced = applyOutsideSpans(enhanced, urlPattern,
          '<span class="hljs-string">$1</span>')

        // 2. Env var assignments: NAME= → colored variable + operator
        enhanced = applyOutsideSpans(enhanced, envVarPattern,
          '<span class="hljs-variable">$1</span><span class="hljs-operator">=</span>')

        // 3. Operators (|, ||, &&)
        enhanced = applyOutsideSpans(enhanced, operatorPattern,
          '<span class="hljs-keyword">$1</span>')

        // 4. Commands (common program names)
        enhanced = applyOutsideSpans(enhanced, cmdPattern,
          '<span class="hljs-built_in">$1</span>')

        // 5. Flags (-x, --flag)
        enhanced = applyOutsideSpans(enhanced, flagPattern,
          '<span class="hljs-attr">$1</span>')

        result.push(enhanced)
      }
    }

    return result.join('')
  }

  hljs.addPlugin({
    'after:highlight': function(result) {
      if (result.language === 'bash' || result.language === 'shell') {
        result.value = enhanceBashHtml(result.value)
      }
    }
  })
})()
