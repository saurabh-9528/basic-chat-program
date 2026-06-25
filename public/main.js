// Establish socket connection (initially disconnected until join)
const socket = io({ autoConnect: false });

// Application State
let username = '';
let currentRoom = 'Lobby';
let isTyping = false;
let typingTimeout = null;
let currentUserProfile = { bio: '', status: 'online', avatarColor: null };
let allUsers = [];
let oldestLoadedTimestamp = null;
let isFiltered = false;
let activeReplyTo = null;
let loadedMessages = new Map();
let activeReactionsPopover = null;
let messageIdToForward = null;
let currentAuthAction = 'login'; // 'login' or 'register'

// Room Descriptions & Icons mapping
const roomMetadata = {
  Lobby: {
    icon: '🌌',
    description: 'Welcome to the main entry lobby of AetherChat.'
  },
  Tech: {
    icon: '💻',
    description: 'Discuss coding, systems, coffee, and all things tech.'
  },
  Random: {
    icon: '🎲',
    description: 'Jokes, casual conversations, memes, and random chatter.'
  }
};

// DOM Elements
const joinModal = document.getElementById('join-modal');
const joinForm = document.getElementById('join-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const roomSelect = document.getElementById('room-select');
const joinError = document.getElementById('join-error');
const joinBtn = document.getElementById('join-btn');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const passwordHelpText = document.getElementById('password-help-text');
const joinModalDescription = document.getElementById('join-modal-description');

const appContainer = document.getElementById('app-container');
const sidebar = document.querySelector('.sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const selfAvatar = document.getElementById('self-avatar');
const selfUsername = document.getElementById('self-username');
const logoutBtn = document.getElementById('logout-btn');

const currentRoomIcon = document.getElementById('current-room-icon');
const currentRoomName = document.getElementById('current-room-name');
const roomDescription = document.getElementById('room-description');

const usersList = document.getElementById('users-list');
const userCount = document.getElementById('user-count');

const messagesContainer = document.getElementById('messages-container');
const chatForm = document.getElementById('chat-form');
const msgInput = document.getElementById('msg-input');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadFilename = document.getElementById('upload-filename');
const uploadPercentage = document.getElementById('upload-percentage');
const uploadProgressBar = document.getElementById('upload-progress-bar');
const searchToggleBtn = document.getElementById('search-toggle-btn');
const calendarBtn = document.getElementById('calendar-btn');
const jumpDatePicker = document.getElementById('jump-date-picker');
const searchPanel = document.getElementById('search-panel');
const searchInput = document.getElementById('search-input');
const clearSearchTextBtn = document.getElementById('clear-search-text-btn');
const filterStatusBar = document.getElementById('filter-status-bar');
const filterStatusText = document.getElementById('filter-status-text');
const clearFilterBtn = document.getElementById('clear-filter-btn');

const typingIndicator = document.getElementById('typing-indicator');
const typingText = document.getElementById('typing-text');

// List of typing users in current room
let typingUsers = new Set();

// Deterministic HSL color generator for user avatars
function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  // Using 70% saturation and 45% lightness for vibrant, accessible colors on dark theme
  return `hsl(${h}, 70%, 45%)`;
}

// Get initials of username (up to 2 chars)
function getInitials(name) {
  const parts = name.split(' ');
  if (parts.length > 1) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

// Auto scroll messages to the bottom
function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Format message text with markdown code blocks, inline code, and @mentions
function formatMessageText(text) {
  let html = escapeHTML(text);
  
  // Detect and format code blocks: ```lang\ncode\n```
  const codeBlockRegex = /```(\w+)?\n([\s\S]+?)\n```/g;
  html = html.replace(codeBlockRegex, (match, lang, code) => {
    const languageClass = lang ? `language-${lang}` : '';
    return `<pre class="code-block"><code class="${languageClass}">${code}</code></pre>`;
  });
  
  // Detect inline code: `code`
  const inlineCodeRegex = /`([^`\n]+)`/g;
  html = html.replace(inlineCodeRegex, (match, code) => {
    return `<code class="inline-code">${code}</code>`;
  });
  
  // Detect and format @mentions. E.g. @username
  allUsers.forEach(u => {
    const escapedUsername = u.username.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const userRegex = new RegExp(`@(${escapedUsername})\\b`, 'gi');
    html = html.replace(userRegex, (match, name) => {
      return `<span class="message-mention">@${name}</span>`;
    });
  });
  
  return html;
}

// Generate message actions bar HTML
function getMessageActionsBarHtml(message, isSelf) {
  return `
    <div class="message-actions-bar">
      <button class="action-btn btn-reply" data-id="${message.id}" data-username="${escapeHTML(message.username)}" data-text="${escapeHTML(message.text || (message.fileName ? `[File] ${message.fileName}` : ''))}" title="Reply">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
      </button>
      <button class="action-btn btn-react" data-id="${message.id}" title="Add Reaction">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
      </button>
      <button class="action-btn btn-pin" data-id="${message.id}" title="${message.isPinned ? 'Unpin Message' : 'Pin Message'}">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.5A2 2 0 0 1 15 9.26V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.26a2 2 0 0 1-.78 1.24l-2.78 3.5A2 2 0 0 0 5 15.24V17z"></path></svg>
      </button>
      <button class="action-btn btn-forward" data-id="${message.id}" title="Forward Message">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
      </button>
    </div>
  `;
}

// Generate reactions list HTML
function getReactionsHtml(messageId, reactions) {
  if (!reactions || Object.keys(reactions).length === 0) {
    return `<div class="message-reactions-container hidden" data-id="${messageId}"></div>`;
  }
  let html = `<div class="message-reactions-container" data-id="${messageId}">`;
  let hasVisibleReactions = false;
  for (const [emoji, users] of Object.entries(reactions)) {
    if (!users || users.length === 0) continue;
    hasVisibleReactions = true;
    const hasSelfReacted = users.includes(username);
    html += `
      <div class="reaction-badge ${hasSelfReacted ? 'active' : ''}" data-message-id="${messageId}" data-emoji="${emoji}" title="${users.join(', ')}">
        <span class="reaction-emoji">${emoji}</span>
        <span class="reaction-count">${users.length}</span>
      </div>
    `;
  }
  html += `</div>`;
  if (!hasVisibleReactions) {
    return `<div class="message-reactions-container hidden" data-id="${messageId}"></div>`;
  }
  return html;
}

// Format message HTML
function displayMessage(message, prepend = false) {
  if (message && !message.system) {
    loadedMessages.set(message.id, message);
  }
  const msgDiv = document.createElement('div');
  msgDiv.setAttribute('data-msg-id', message.id);
  
  if (message.system) {
    msgDiv.classList.add('message', 'system-msg');
    msgDiv.innerHTML = `
      <div class="message-bubble">
        ${escapeHTML(message.text)}
      </div>
    `;
  } else {
    const isSelf = message.username === username;
    msgDiv.classList.add('message', isSelf ? 'self' : 'other');
    
    const initials = getInitials(message.username);
    const color = getAvatarColor(message.username);
    
    let bubbleContent = '';
    
    if (message.fileUrl) {
      const escapedUrl = escapeHTML(message.fileUrl);
      const escapedName = escapeHTML(message.fileName || 'file');
      const fileType = message.fileType || '';
      const fileSize = message.fileSize || 0;
      
      if (fileType.startsWith('image/')) {
        bubbleContent += `
          <div class="file-preview-container image-preview">
            <a href="${escapedUrl}" target="_blank">
              <img src="${escapedUrl}" alt="${escapedName}" class="message-image" />
            </a>
          </div>
        `;
      } else if (fileType.startsWith('video/')) {
        bubbleContent += `
          <div class="file-preview-container video-preview">
            <video src="${escapedUrl}" class="message-video" controls preload="metadata" playsinline></video>
          </div>
        `;
      } else if (fileType === 'application/pdf') {
        const uniqueId = `pdf-${message.id || Math.random().toString(36).substr(2, 9)}`;
        bubbleContent += `
          <div class="file-preview-container pdf-preview-card">
            <div class="pdf-icon">
              <svg viewBox="0 0 24 24" width="36" height="36" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="pdf-svg">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
            </div>
            <div class="pdf-info">
              <span class="pdf-name" title="${escapedName}">${escapedName}</span>
              <span class="pdf-size">${formatBytes(fileSize)}</span>
            </div>
            <div class="pdf-actions">
              <button type="button" class="pdf-btn btn-preview-toggle" data-target="${uniqueId}" title="Toggle Preview">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
              </button>
              <a href="${escapedUrl}" target="_blank" class="pdf-btn btn-view" title="Open PDF">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
              </a>
              <a href="${escapedUrl}" download="${escapedName}" class="pdf-btn btn-download" title="Download">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
              </a>
            </div>
          </div>
          <!-- Toggleable PDF Inline Preview -->
          <div id="${uniqueId}" class="pdf-embed-container hidden">
            <iframe src="${escapedUrl}#toolbar=0" class="pdf-iframe-preview"></iframe>
          </div>
        `;
      } else {
        // Generic file card
        bubbleContent += `
          <div class="file-preview-container pdf-preview-card generic-file-card">
            <div class="pdf-icon">
              <svg viewBox="0 0 24 24" width="36" height="36" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="file-svg">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
            </div>
            <div class="pdf-info">
              <span class="pdf-name" title="${escapedName}">${escapedName}</span>
              <span class="pdf-size">${formatBytes(fileSize)}</span>
            </div>
            <div class="pdf-actions">
              <a href="${escapedUrl}" download="${escapedName}" class="pdf-btn btn-download" title="Download">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
              </a>
            </div>
          </div>
        `;
      }
      
      if (message.text) {
        bubbleContent += `<div class="file-caption">${formatMessageText(message.text)}</div>`;
      }
    } else {
      bubbleContent = formatMessageText(message.text);
    }
    
    let replyReferenceHtml = '';
    if (message.replyTo) {
      replyReferenceHtml = `
        <div class="reply-reference" data-reply-id="${message.replyTo}">
          <span class="reply-ref-sender">@${escapeHTML(message.replyToUsername)}</span>
          <span class="reply-ref-text">${escapeHTML(message.replyToText)}</span>
        </div>
      `;
    }
    
    const actionsBarHtml = getMessageActionsBarHtml(message, isSelf);
    const reactionsHtml = getReactionsHtml(message.id, message.reactions);
    
    msgDiv.innerHTML = `
      <div class="message-meta">
        <span class="message-sender">${escapeHTML(message.username)}</span>
        ${message.isPinned ? '<span class="pinned-indicator" title="Pinned Message">📌 Pinned</span>' : ''}
        <span class="message-time">${message.time}</span>
      </div>
      <div class="message-bubble" style="${isSelf ? '' : 'border-left: 3px solid ' + color}">
        ${replyReferenceHtml}
        ${bubbleContent}
      </div>
      ${actionsBarHtml}
      ${reactionsHtml}
    `;
  }
  
  if (prepend) {
    messagesContainer.insertBefore(msgDiv, messagesContainer.firstChild);
  } else {
    messagesContainer.appendChild(msgDiv);
  }
  
  // Highlight code blocks
  msgDiv.querySelectorAll('pre code').forEach(el => {
    hljs.highlightElement(el);
  });
  
  if (!prepend) {
    scrollToBottom();
  }
}

// Escape HTML characters to prevent XSS
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// Auth tab switching logic
if (tabLogin && tabRegister) {
  tabLogin.addEventListener('click', () => {
    currentAuthAction = 'login';
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    if (passwordHelpText) passwordHelpText.classList.add('hidden');
    if (joinModalDescription) joinModalDescription.textContent = 'Enter a username to join the real-time space.';
    if (joinBtn) joinBtn.textContent = 'Log In';
    // Clear error on tab switch
    if (joinError) {
      joinError.classList.add('hidden');
      joinError.textContent = '';
    }
  });

  tabRegister.addEventListener('click', () => {
    currentAuthAction = 'register';
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    if (passwordHelpText) passwordHelpText.classList.remove('hidden');
    if (joinModalDescription) joinModalDescription.textContent = 'Create a new account by choosing a username and password.';
    if (joinBtn) joinBtn.textContent = 'Sign Up';
    // Clear error on tab switch
    if (joinError) {
      joinError.classList.add('hidden');
      joinError.textContent = '';
    }
  });
}

// Handle Joining a room
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const enteredUsername = usernameInput.value.trim();
  const password = passwordInput.value;
  const targetRoom = roomSelect.value;
  
  if (!enteredUsername || !password) return;

  // Validate username format client-side
  const usernameRegex = /^[a-zA-Z0-9 _-]+$/;
  if (enteredUsername.length < 3 || enteredUsername.length > 20 || !usernameRegex.test(enteredUsername)) {
    joinError.textContent = 'Username must be 3-20 characters and contain only letters, numbers, spaces, underscores, or hyphens.';
    joinError.classList.remove('hidden');
    return;
  }

  // Clear previous error
  joinError.classList.add('hidden');
  joinError.textContent = '';

  // Show loading state
  joinBtn.disabled = true;
  joinBtn.textContent = 'Connecting...';
  usernameInput.disabled = true;
  passwordInput.disabled = true;
  roomSelect.disabled = true;

  // Establish connection if not connected
  if (!socket.connected) {
    socket.connect();
  }

  // Attempt to join the room (which will perform auth validation)
  socket.emit('joinRoom', { username: enteredUsername, password, room: targetRoom, action: currentAuthAction });
});

// Update current room display header
function updateRoomHeader(room) {
  const meta = roomMetadata[room] || roomMetadata.Lobby;
  currentRoomIcon.textContent = meta.icon;
  currentRoomName.textContent = room;
  roomDescription.textContent = meta.description;
}


// Send Message
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  
  const msgText = msgInput.value.trim();
  if (!msgText) return;

  // Emit message to server
  if (activeReplyTo) {
    socket.emit('chatMessage', {
      text: msgText,
      replyTo: activeReplyTo.id,
      replyToUsername: activeReplyTo.username,
      replyToText: activeReplyTo.text
    });
    clearActiveReply();
  } else {
    socket.emit('chatMessage', msgText);
  }

  // Reset input field & typing state
  msgInput.value = '';
  msgInput.focus();
  
  if (isTyping) {
    isTyping = false;
    socket.emit('typing', false);
    clearTimeout(typingTimeout);
  }
});

// Typing event detection
msgInput.addEventListener('input', () => {
  if (!isTyping) {
    isTyping = true;
    socket.emit('typing', true);
  }

  // Clear previous timeout and set a new one to turn off typing indicator
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    socket.emit('typing', false);
  }, 2000);
});

// Direct Messaging State
const unreadCounts = {};

function startDM(targetUser) {
  // Close sidebar on mobile
  closeSidebar();
  
  const targetKey = targetUser.toLowerCase();
  
  // Clear unread count/badge
  unreadCounts[targetKey] = 0;
  const badge = document.getElementById(`unread-${targetKey}`);
  if (badge) {
    badge.classList.add('hidden');
    badge.textContent = '0';
  }
  updateDocumentTitle();

  // Deactivate room list items
  document.querySelectorAll('#rooms-list li').forEach(li => li.classList.remove('active'));

  // Calculate DM room name
  const sorted = [username.toLowerCase(), targetKey].sort();
  const dmRoom = `dm:${sorted[0]}:${sorted[1]}`;

  if (currentRoom === dmRoom) return;

  currentRoom = dmRoom;

  // Highlight active member in sidebar
  document.querySelectorAll('.member-item').forEach(li => {
    if (li.dataset.username.toLowerCase() === targetKey) {
      li.classList.add('active');
    } else {
      li.classList.remove('active');
    }
  });

  // Update header UI
  updateDMHeader();

  // Clear messages container for transition
  messagesContainer.innerHTML = '';
  typingUsers.clear();
  updateTypingIndicator();

  // Switch room
  socket.emit('joinRoom', { username, room: currentRoom });
}

// Render the active users lists
function renderUsersList(users) {
  usersList.innerHTML = users
    .map(user => {
      const initials = getInitials(user.username);
      const color = user.avatarColor || getAvatarColor(user.username);
      const isSelf = user.username.toLowerCase() === username.toLowerCase();
      const targetKey = user.username.toLowerCase();
      const unreadCount = unreadCounts[targetKey] || 0;
      
      // Keep active class if we are currently in a DM with this user
      const isCurrentDM = currentRoom.startsWith('dm:') && 
                          currentRoom.split(':').includes(targetKey);

      let statusClass = 'status-offline';
      if (user.status === 'online') statusClass = 'status-online';
      else if (user.status === 'away') statusClass = 'status-away';
      else if (user.status === 'busy') statusClass = 'status-busy';

      return `
        <li class="${isSelf ? 'self-user' : 'member-item'}${isCurrentDM ? ' active' : ''}" data-username="${escapeHTML(user.username)}" style="${isSelf ? '' : 'cursor: pointer;'}">
          <div class="avatar-container" style="position: relative; width: 28px; height: 28px; flex-shrink: 0;">
            <div class="user-avatar" style="background: ${color}; width: 100%; height: 100%; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 600; color: white;">${initials}</div>
            <span class="status-dot ${statusClass}"></span>
          </div>
          <div class="user-details" style="display: flex; flex-direction: column; flex-grow: 1; margin-left: 10px; overflow: hidden;">
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
              <span class="user-name" style="color: ${isSelf ? '#c084fc' : 'var(--text-muted)'}; font-weight: ${isCurrentDM ? '600' : 'normal'}; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(user.username)} ${isSelf ? '(You)' : ''}</span>
              <span id="unread-${targetKey}" class="unread-badge ${unreadCount > 0 ? '' : 'hidden'}">${unreadCount}</span>
            </div>
            ${user.bio ? `<span class="user-bio-small" style="font-size: 0.75rem; color: var(--text-dimmed); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;">${escapeHTML(user.bio)}</span>` : ''}
          </div>
        </li>
      `;
    })
    .join('');
  
  // Calculate count of online users
  const onlineCount = users.filter(u => u.status !== 'offline').length;
  userCount.textContent = `${onlineCount}/${users.length}`;

  // Add click handler to member items
  document.querySelectorAll('.member-item').forEach(item => {
    item.addEventListener('click', () => {
      const targetUser = item.dataset.username;
      startDM(targetUser);
    });
  });
}

// Update the typing UI text based on active typers
function updateTypingIndicator() {
  if (typingUsers.size === 0) {
    typingIndicator.classList.add('hidden');
  } else {
    typingIndicator.classList.remove('hidden');
    const typers = Array.from(typingUsers);
    if (typers.length === 1) {
      typingText.textContent = `${typers[0]} is typing...`;
    } else if (typers.length === 2) {
      typingText.textContent = `${typers[0]} and ${typers[1]} are typing...`;
    } else {
      typingText.textContent = 'Multiple members are typing...';
    }
  }
}

// SOCKET.IO EVENT LISTENERS

// Receive history when entering a room
socket.on('roomHistory', (history) => {
  messagesContainer.innerHTML = '';
  loadedMessages.clear();
  history.forEach(msg => {
    loadedMessages.set(msg.id, msg);
    displayMessage(msg);
  });
  
  // Track oldest loaded timestamp for lazy loading
  if (history.length > 0) {
    oldestLoadedTimestamp = history[0].timestamp || null;
  } else {
    oldestLoadedTimestamp = null;
  }
  isFiltered = false;
  
  scrollToBottom();
});

// Receive chat/system message
socket.on('message', (message) => {
  if (!message.system) {
    loadedMessages.set(message.id, message);
  }
  const isSelf = message.username === username;
  
  // Play notification sound for incoming messages from others
  if (!isSelf && !message.system) {
    playDingSound();
  }

  const isCurrentRoom = message.room === currentRoom;

  // Display message if system message, has no room, or is in the current room
  if (message.system || !message.room || isCurrentRoom) {
    displayMessage(message);
  }

  // Handle DM notifications & unread counts
  if (!isSelf && message.room && message.room.startsWith('dm:')) {
    const senderKey = message.username.toLowerCase();
    
    // We increment unread count if it's NOT the current room, OR if the tab is hidden
    if (!isCurrentRoom || document.hidden) {
      unreadCounts[senderKey] = (unreadCounts[senderKey] || 0) + 1;
      
      const badge = document.getElementById(`unread-${senderKey}`);
      if (badge) {
        badge.textContent = unreadCounts[senderKey];
        badge.classList.remove('hidden');
      }
      updateDocumentTitle();
    }
    
    // Show system push notification if tab is hidden
    if (document.hidden && window.Notification && Notification.permission === 'granted') {
      new Notification(`New message from ${message.username}`, {
        body: message.text,
        icon: '/favicon.ico'
      });
    }
  }
});

// Receive updated global user list
socket.on('globalUsers', (users) => {
  allUsers = users;
  renderUsersList(users);
  
  // If we are currently in a DM, update the header details dynamically
  if (currentRoom && currentRoom.startsWith('dm:')) {
    updateDMHeader();
  }
});

// Receive updated rooms list from server
socket.on('roomsList', (rooms) => {
  // Populate the select dropdown in join modal
  if (roomSelect) {
    const currentValue = roomSelect.value;
    roomSelect.innerHTML = rooms.map(room => {
      return `<option value="${escapeHTML(room.name)}">${escapeHTML(room.name)}</option>`;
    }).join('');
    if (currentValue && rooms.some(r => r.name === currentValue)) {
      roomSelect.value = currentValue;
    }
  }

  // Populate the sidebar rooms list
  const roomsListContainer = document.getElementById('rooms-list');
  if (roomsListContainer) {
    roomsListContainer.innerHTML = rooms.map(room => {
      const meta = roomMetadata[room.name] || { icon: '🚪', description: room.description || '' };
      const isActive = room.name === currentRoom;
      const hasPassword = room.hasPassword;
      const countBadge = room.activeCount > 0 ? `<span class="badge">${room.activeCount}</span>` : '';
      
      return `
        <li class="${isActive ? 'active' : ''}" data-room="${escapeHTML(room.name)}" title="${escapeHTML(room.description || room.name)}">
          <span class="room-icon">${meta.icon}</span>
          <span class="room-name" style="flex-grow: 1;">${escapeHTML(room.name)}${hasPassword ? ' 🔒' : ''}</span>
          ${countBadge}
        </li>
      `;
    }).join('');

    // Re-attach event listeners since list items are recreated dynamically
    const newRoomsListItems = roomsListContainer.querySelectorAll('li');
    newRoomsListItems.forEach(item => {
      item.addEventListener('click', () => {
        const targetRoom = item.dataset.room;
        
        // Close sidebar on mobile
        closeSidebar();
        
        if (targetRoom === currentRoom) return;

        const roomData = rooms.find(r => r.name === targetRoom);
        if (roomData && roomData.hasPassword) {
          pendingRoomSwitch = targetRoom;
          if (roomPasswordModal) {
            roomPasswordModal.classList.remove('hidden');
            if (joinRoomPasswordInput) { 
              joinRoomPasswordInput.value = ''; 
              joinRoomPasswordInput.focus(); 
            }
          }
          return;
        }

        switchToRoom(targetRoom, null);
      });
    });
  }
});

// Receive other user's typing status
socket.on('typingStatus', ({ username: typerName, isTyping: userIsTyping }) => {
  if (userIsTyping) {
    typingUsers.add(typerName);
  } else {
    typingUsers.delete(typerName);
  }
  updateTypingIndicator();
});

// Handle successful join / authentication
socket.on('joinSuccess', ({ username: acceptedUsername, room: acceptedRoom, token, bio, status, avatarColor }) => {
  // Update local application state
  username = acceptedUsername;
  currentRoom = acceptedRoom;
  
  currentUserProfile = { bio: bio || '', status: status || 'online', avatarColor: avatarColor || null };

  // Store credentials in localStorage for session persistence
  if (token) {
    localStorage.setItem('aetherchat_token', token);
    localStorage.setItem('aetherchat_username', username);
    localStorage.setItem('aetherchat_room', currentRoom);
  }

  // Initialize UI Profile details
  updateSelfProfileUI();

  // Setup UI room focus
  updateRoomHeader(currentRoom);
  document.querySelectorAll('#rooms-list li').forEach(item => {
    if (item.dataset.room === currentRoom) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Switch views
  joinModal.classList.add('hidden');
  appContainer.classList.remove('hidden');

  // Request browser notification permission
  if (window.Notification && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
    Notification.requestPermission();
  }

  // Reset join form inputs & state
  joinBtn.disabled = false;
  joinBtn.textContent = 'Enter Space';
  usernameInput.disabled = false;
  passwordInput.disabled = false;
  roomSelect.disabled = false;

  // Focus main message input
  msgInput.focus();
});

// Handle join / authentication error
socket.on('joinError', (errorMessage) => {
  // Disconnect the socket connection since join failed
  socket.disconnect();

  // Clear expired/invalid session tokens
  if (errorMessage.toLowerCase().includes('session') || errorMessage.toLowerCase().includes('credential')) {
    localStorage.removeItem('aetherchat_token');
    localStorage.removeItem('aetherchat_username');
    localStorage.removeItem('aetherchat_room');
  }

  // Display error message
  joinError.textContent = errorMessage;
  joinError.classList.remove('hidden');

  // Re-enable form fields
  joinBtn.disabled = false;
  joinBtn.textContent = currentAuthAction === 'login' ? 'Log In' : 'Sign Up';
  usernameInput.disabled = false;
  passwordInput.disabled = false;
  roomSelect.disabled = false;
});

// Handle logout
logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('aetherchat_token');
  localStorage.removeItem('aetherchat_username');
  localStorage.removeItem('aetherchat_room');
  
  // Clear application state
  username = '';
  currentRoom = 'Lobby';
  
  // Disconnect socket
  socket.disconnect();

  // Reset form inputs & messages
  passwordInput.value = '';
  usernameInput.value = '';
  messagesContainer.innerHTML = '';
  joinError.classList.add('hidden');
  joinError.textContent = '';

  // Switch UI views
  appContainer.classList.add('hidden');
  joinModal.classList.remove('hidden');
});

// Auto-reconnect & re-authenticate when socket connects/reconnects
socket.on('connect', () => {
  // Request the latest room list from server
  socket.emit('getRoomsList');

  const savedToken = localStorage.getItem('aetherchat_token');
  const savedUsername = localStorage.getItem('aetherchat_username');
  const savedRoom = localStorage.getItem('aetherchat_room') || 'Lobby';

  if (savedToken && savedUsername) {
    socket.emit('joinRoom', { username: savedUsername, token: savedToken, room: savedRoom });
  }
});

// Initial check for active session on page load
window.addEventListener('DOMContentLoaded', () => {
  const savedToken = localStorage.getItem('aetherchat_token');
  const savedUsername = localStorage.getItem('aetherchat_username');

  if (savedToken && savedUsername) {
    // Show a loading UI state on the join form while we verify the token
    joinBtn.disabled = true;
    joinBtn.textContent = 'Restoring session...';
    usernameInput.disabled = true;
    passwordInput.disabled = true;
    roomSelect.disabled = true;
  }

  // Connect socket immediately to fetch room list
  socket.connect();
});

// SIDEBAR INTERACTIONS
function openSidebar() {
  if (sidebar && sidebarOverlay) {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('active');
  }
}

function closeSidebar() {
  if (sidebar && sidebarOverlay) {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('active');
  }
}

function toggleSidebar() {
  if (sidebar && sidebar.classList.contains('open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

// Event Listeners for Sidebar Toggle
if (sidebarToggle) {
  sidebarToggle.addEventListener('click', toggleSidebar);
}
if (sidebarOverlay) {
  sidebarOverlay.addEventListener('click', closeSidebar);
}

// Swipe gesture detection
let touchStartX = 0;
let touchStartY = 0;

document.addEventListener('touchstart', (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (!sidebar) return;
  
  const touchEndX = e.changedTouches[0].clientX;
  const touchEndY = e.changedTouches[0].clientY;
  
  const diffX = touchEndX - touchStartX;
  const diffY = touchEndY - touchStartY;
  
  const isSidebarOpen = sidebar.classList.contains('open');
  
  // Swipe detection: swipe length > 60px and angle mostly horizontal (< 50px vertical diff)
  if (Math.abs(diffX) > 60 && Math.abs(diffY) < 50) {
    if (diffX < 0 && isSidebarOpen) {
      // Swipe left on open sidebar -> Close
      closeSidebar();
    } else if (diffX > 0 && !isSidebarOpen && touchStartX < 60) {
      // Swipe right from the left edge of screen -> Open
      openSidebar();
    }
  }
}, { passive: true });

// Dynamic viewport adjustments for virtual keyboard
function adjustViewportHeight() {
  const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--viewport-height', `${height}px`);
  
  // Scroll messages to bottom when height changes (e.g. keyboard shown)
  if (document.activeElement === msgInput) {
    setTimeout(scrollToBottom, 100);
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', adjustViewportHeight);
  window.visualViewport.addEventListener('scroll', adjustViewportHeight);
} else {
  window.addEventListener('resize', adjustViewportHeight);
}

// Initial viewport run
adjustViewportHeight();

// Document Title updating function
function updateDocumentTitle() {
  const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);
  if (totalUnread > 0) {
    document.title = `(${totalUnread}) AetherChat — Realtime Space`;
  } else {
    document.title = 'AetherChat — Realtime Space';
  }
}

// Programmatic Beep Sound using Web Audio API
function playDingSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    osc.type = 'sine';
    // D5 note (587.33 Hz) is a beautiful, clean chime note
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    
    // Smooth envelope to avoid clicks (very fast attack, exponential decay)
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.36);
  } catch (err) {
    console.error('Audio context error:', err);
  }
}

// Reset unread count for current DM room when tab is focused
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (currentRoom && currentRoom.startsWith('dm:')) {
      const parts = currentRoom.split(':');
      const partnerKey = parts[1] === username.toLowerCase() ? parts[2] : parts[1];
      
      if (unreadCounts[partnerKey]) {
        unreadCounts[partnerKey] = 0;
        const badge = document.getElementById(`unread-${partnerKey}`);
        if (badge) {
          badge.classList.add('hidden');
          badge.textContent = '0';
        }
        updateDocumentTitle();
      }
      
      // Update DM header details on focus returning
      updateDMHeader();
    }
  }
});

// Update self profile card at bottom-left
function updateSelfProfileUI() {
  if (!username) return;
  selfUsername.textContent = username;
  selfAvatar.textContent = getInitials(username);
  
  const color = currentUserProfile.avatarColor || getAvatarColor(username);
  selfAvatar.style.background = color;
  
  const indicator = document.querySelector('.user-profile .status-indicator');
  if (indicator) {
    indicator.className = 'status-indicator';
    if (currentUserProfile.status === 'online') {
      indicator.classList.add('online');
      indicator.textContent = 'Available';
    } else if (currentUserProfile.status === 'away') {
      indicator.classList.add('away');
      indicator.textContent = 'Away';
    } else if (currentUserProfile.status === 'busy') {
      indicator.classList.add('busy');
      indicator.textContent = 'Busy';
    }
  }
}

// Update DM conversation header (name, status dot/label, bio, last seen)
function updateDMHeader() {
  if (!currentRoom.startsWith('dm:')) return;
  
  const parts = currentRoom.split(':');
  const partnerKey = parts[1] === username.toLowerCase() ? parts[2] : parts[1];
  
  const partner = allUsers.find(u => u.username.toLowerCase() === partnerKey);
  if (!partner) return;
  
  currentRoomIcon.textContent = '💬';
  currentRoomName.textContent = partner.username;
  
  let statusText = '';
  if (partner.status === 'online') statusText = '🟢 Available';
  else if (partner.status === 'away') statusText = '🟡 Away';
  else if (partner.status === 'busy') statusText = '🔴 Busy';
  else {
    statusText = '⚪ Offline';
    if (partner.lastSeen) {
      statusText += ` (Last seen ${formatLastSeen(partner.lastSeen)})`;
    }
  }
  
  const bioText = partner.bio ? ` | Bio: ${partner.bio}` : '';
  roomDescription.textContent = `${statusText}${bioText}`;
}

// Helper to format last seen time in a friendly way
function formatLastSeen(timestamp) {
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hr${diffHours > 1 ? 's' : ''} ago`;
  
  return new Date(timestamp).toLocaleDateString();
}

// HSL to Hex converters for the color picker
function getAvatarColorHex(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return hslToHex(h, 70, 45);
}

function hslToHex(h, s, l) {
  l /= 100;
  const a = s * Math.min(l, 1 - l) / 100;
  const f = n => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Profile Modal Interactions
const userProfileCard = document.querySelector('.user-profile');
const profileModal = document.getElementById('profile-modal');
const profileForm = document.getElementById('profile-form');
const profileCancelBtn = document.getElementById('profile-cancel-btn');
const profileError = document.getElementById('profile-error');

if (userProfileCard) {
  userProfileCard.addEventListener('click', (e) => {
    if (e.target.closest('#logout-btn')) return;
    
    // Reset errors
    if (profileError) {
      profileError.classList.add('hidden');
      profileError.textContent = '';
    }
    
    // Populate form fields
    document.getElementById('profile-status').value = currentUserProfile.status || 'online';
    document.getElementById('profile-bio').value = currentUserProfile.bio || '';
    document.getElementById('profile-color').value = currentUserProfile.avatarColor || getAvatarColorHex(username);
    
    if (profileModal) {
      profileModal.classList.remove('hidden');
    }
  });
}

if (profileCancelBtn) {
  profileCancelBtn.addEventListener('click', () => {
    if (profileModal) {
      profileModal.classList.add('hidden');
    }
  });
}

if (profileForm) {
  profileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const bio = document.getElementById('profile-bio').value.trim();
    const status = document.getElementById('profile-status').value;
    const avatarColor = document.getElementById('profile-color').value;
    
    socket.emit('updateProfile', { bio, status, avatarColor });
  });
}

// Handle profile update events
socket.on('profileUpdateSuccess', ({ bio, status, avatarColor }) => {
  currentUserProfile = { bio, status, avatarColor };
  updateSelfProfileUI();
  if (profileModal) {
    profileModal.classList.add('hidden');
  }
});

socket.on('profileUpdateError', (errorMsg) => {
  if (profileError) {
    profileError.textContent = errorMsg;
    profileError.classList.remove('hidden');
  }
});

// PDF Preview Toggle Delegation
if (messagesContainer) {
  messagesContainer.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('.btn-preview-toggle');
    if (!toggleBtn) return;

    const targetId = toggleBtn.dataset.target;
    const targetPreview = document.getElementById(targetId);
    if (targetPreview) {
      targetPreview.classList.toggle('hidden');
      toggleBtn.classList.toggle('active');
    }
  });
}

// Attach button triggers file input
if (attachBtn && fileInput) {
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;

    // Enforce 5MB file size limit client-side
    const maxSizeBytes = 5 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      alert(`File size exceeds 5MB limit. Selected file size: ${formatBytes(file.size)}`);
      fileInput.value = '';
      return;
    }

    uploadFile(file);
  });
}

// Upload file to server via XHR (to track progress)
function uploadFile(file) {
  const token = localStorage.getItem('aetherchat_token');
  if (!token) {
    alert('You must be logged in to upload files.');
    return;
  }

  // Show progress bar
  if (uploadProgressContainer) {
    uploadProgressContainer.classList.remove('hidden');
    uploadFilename.textContent = file.name;
    uploadPercentage.textContent = '0%';
    uploadProgressBar.style.width = '0%';
  }

  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload', true);
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const percentComplete = Math.round((e.loaded / e.total) * 100);
      if (uploadPercentage && uploadProgressBar) {
        uploadPercentage.textContent = `${percentComplete}%`;
        uploadProgressBar.style.width = `${percentComplete}%`;
      }
    }
  });

  xhr.addEventListener('load', () => {
    if (uploadProgressContainer) {
      uploadProgressContainer.classList.add('hidden');
    }
    fileInput.value = '';

    if (xhr.status === 200) {
      try {
        const response = JSON.parse(xhr.responseText);
        // Send file message via socket
        socket.emit('chatMessage', {
          text: '',
          file: response
        });
      } catch (err) {
        console.error('Failed to parse upload response:', err);
        alert('Upload failed: Invalid server response.');
      }
    } else {
      try {
        const errorRes = JSON.parse(xhr.responseText);
        alert(`Upload failed: ${errorRes.error || 'Server error'}`);
      } catch (err) {
        alert('Upload failed: Server error.');
      }
    }
  });

  xhr.addEventListener('error', () => {
    if (uploadProgressContainer) {
      uploadProgressContainer.classList.add('hidden');
    }
    fileInput.value = '';
    alert('Upload failed: Network error.');
  });

  xhr.addEventListener('abort', () => {
    if (uploadProgressContainer) {
      uploadProgressContainer.classList.add('hidden');
    }
    fileInput.value = '';
  });

  xhr.send(formData);
}

// Utility to format file sizes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// --- Search & History Features Client Logic ---

// Toggle search panel
if (searchToggleBtn && searchPanel) {
  searchToggleBtn.addEventListener('click', () => {
    searchPanel.classList.toggle('hidden');
    searchToggleBtn.classList.toggle('active');
    if (!searchPanel.classList.contains('hidden')) {
      searchInput.focus();
    }
  });
}

// Clear search input text
if (clearSearchTextBtn && searchInput) {
  clearSearchTextBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchInput.focus();
    if (isFiltered) {
      clearAllFilters();
    }
  });
}

// Debounced Search (on input change)
let searchDebounceTimeout = null;
if (searchInput) {
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => {
      const query = searchInput.value.trim();
      if (query.length >= 2) {
        isFiltered = true;
        socket.emit('searchMessages', { room: currentRoom, query });
      } else if (query.length === 0) {
        clearAllFilters();
      }
    }, 400);
  });
}

// Receive Search Results from Server
socket.on('searchResults', ({ query, results }) => {
  messagesContainer.innerHTML = '';
  if (results.length === 0) {
    const noResults = document.createElement('div');
    noResults.className = 'message system-msg';
    noResults.innerHTML = `<div class="message-bubble">No matches found for "${escapeHTML(query)}"</div>`;
    messagesContainer.appendChild(noResults);
  } else {
    results.forEach(displayMessage);
  }
  
  if (filterStatusBar && filterStatusText) {
    filterStatusText.textContent = `Showing search results for "${query}" (${results.length} matches)`;
    filterStatusBar.classList.remove('hidden');
  }
  
  scrollToBottom();
});

// Trigger native date picker on calendar button click
if (calendarBtn && jumpDatePicker) {
  calendarBtn.addEventListener('click', () => {
    jumpDatePicker.showPicker ? jumpDatePicker.showPicker() : jumpDatePicker.click();
  });

  jumpDatePicker.addEventListener('change', () => {
    const selectedDate = jumpDatePicker.value;
    if (!selectedDate) return;

    const dateParts = selectedDate.split('-');
    if (dateParts.length !== 3) return;
    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1;
    const day = parseInt(dateParts[2], 10);

    const start = new Date(year, month, day, 0, 0, 0, 0).getTime();
    const end = new Date(year, month, day, 23, 59, 59, 999).getTime();

    isFiltered = true;
    socket.emit('getMessagesByDate', { room: currentRoom, date: selectedDate, start, end });
  });
}

// Receive Messages by Date from Server
socket.on('dateMessages', ({ date, results }) => {
  messagesContainer.innerHTML = '';
  if (results.length === 0) {
    const noResults = document.createElement('div');
    noResults.className = 'message system-msg';
    noResults.innerHTML = `<div class="message-bubble">No messages found on ${date}</div>`;
    messagesContainer.appendChild(noResults);
  } else {
    results.forEach(displayMessage);
  }

  if (filterStatusBar && filterStatusText) {
    filterStatusText.textContent = `Showing messages from ${date} (${results.length} found)`;
    filterStatusBar.classList.remove('hidden');
  }

  scrollToBottom();
});

// Infinite Scroll / Lazy Loading (Scroll up pagination)
if (messagesContainer) {
  messagesContainer.addEventListener('scroll', () => {
    // Only load more if scrolled to top, not currently filtered/searching, and oldestLoadedTimestamp is set
    if (messagesContainer.scrollTop === 0 && !isFiltered && oldestLoadedTimestamp) {
      socket.emit('loadMoreMessages', { room: currentRoom, beforeTimestamp: oldestLoadedTimestamp });
    }
  });
}

// Receive More Messages (Older history) from Server
socket.on('moreMessages', ({ results }) => {
  if (!results || results.length === 0) return;

  // Capture current scroll scrollHeight to maintain scroll position after prepending
  const previousScrollHeight = messagesContainer.scrollHeight;
  const previousScrollTop = messagesContainer.scrollTop;

  // Prepend oldest messages in reverse order so they are displayed at the top chronologically
  for (let i = results.length - 1; i >= 0; i--) {
    displayMessage(results[i], true);
  }

  // Update oldest timestamp to the new first message's timestamp
  oldestLoadedTimestamp = results[0].timestamp || null;

  // Restore scroll position so scrollbar doesn't jump
  messagesContainer.scrollTop = previousScrollTop + (messagesContainer.scrollHeight - previousScrollHeight);
});

// Clear filter button action (return to live timeline)
if (clearFilterBtn) {
  clearFilterBtn.addEventListener('click', () => {
    clearAllFilters();
  });
}

// Function to clear all search and date filters and reload room history
function clearAllFilters() {
  isFiltered = false;
  
  if (filterStatusBar) {
    filterStatusBar.classList.add('hidden');
  }
  if (searchPanel) {
    searchPanel.classList.add('hidden');
  }
  if (searchToggleBtn) {
    searchToggleBtn.classList.remove('active');
  }
  if (searchInput) {
    searchInput.value = '';
  }
  if (jumpDatePicker) {
    jumpDatePicker.value = '';
  }

  // Reload the current room's live history by rejoining the room
  socket.emit('joinRoom', { username, room: currentRoom });
}

// Clear reply state helper
function clearActiveReply() {
  activeReplyTo = null;
  const indicator = document.getElementById('reply-indicator');
  if (indicator) {
    indicator.classList.add('hidden');
  }
}

// Bind cancel reply button
const cancelReplyBtn = document.getElementById('cancel-reply-btn');
if (cancelReplyBtn) {
  cancelReplyBtn.addEventListener('click', clearActiveReply);
}

// Message actions click delegation on messagesContainer
if (messagesContainer) {
  messagesContainer.addEventListener('click', (e) => {
    // 1. Click on reply reference -> scroll to original message
    const replyRef = e.target.closest('.reply-reference');
    if (replyRef) {
      const replyId = replyRef.dataset.replyId;
      const targetBubble = document.querySelector(`.message[data-msg-id="${replyId}"] .message-bubble`);
      if (targetBubble) {
        targetBubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetBubble.classList.add('highlight-flash');
        setTimeout(() => {
          targetBubble.classList.remove('highlight-flash');
        }, 2000);
      }
      return;
    }

    // 2. Click on Reply button
    const replyBtn = e.target.closest('.btn-reply');
    if (replyBtn) {
      activeReplyTo = {
        id: replyBtn.dataset.id,
        username: replyBtn.dataset.username,
        text: replyBtn.dataset.text
      };
      document.getElementById('reply-username').textContent = activeReplyTo.username;
      document.getElementById('reply-text-preview').textContent = activeReplyTo.text;
      document.getElementById('reply-indicator').classList.remove('hidden');
      msgInput.focus();
      return;
    }

    // 3. Click on React button
    const reactBtn = e.target.closest('.btn-react');
    if (reactBtn) {
      showReactionsPopover(reactBtn, reactBtn.dataset.id);
      return;
    }

    // 4. Click on Pin button
    const pinBtn = e.target.closest('.btn-pin');
    if (pinBtn) {
      socket.emit('togglePinMessage', { messageId: pinBtn.dataset.id });
      return;
    }

    // 5. Click on Forward button
    const forwardBtn = e.target.closest('.btn-forward');
    if (forwardBtn) {
      openForwardModal(forwardBtn.dataset.id);
      return;
    }

    // 6. Click on reaction badge
    const badge = e.target.closest('.reaction-badge');
    if (badge) {
      socket.emit('toggleReaction', {
        messageId: badge.dataset.messageId,
        emoji: badge.dataset.emoji
      });
      return;
    }
  });
}

// Reactions Popover Logic
const quickEmojis = ['👍', '❤️', '😂', '🎉', '🔥', '😮'];
function showReactionsPopover(buttonElement, messageId) {
  if (activeReactionsPopover) {
    activeReactionsPopover.remove();
  }
  
  const popover = document.createElement('div');
  popover.className = 'reactions-popover';
  
  quickEmojis.forEach(emoji => {
    const emojiBtn = document.createElement('button');
    emojiBtn.className = 'popover-emoji-btn';
    emojiBtn.textContent = emoji;
    emojiBtn.addEventListener('click', () => {
      socket.emit('toggleReaction', { messageId, emoji });
      popover.remove();
      activeReactionsPopover = null;
    });
    popover.appendChild(emojiBtn);
  });
  
  const rect = buttonElement.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.top = `${rect.top - 42}px`;
  popover.style.left = `${rect.left}px`;
  popover.style.zIndex = '1000';
  
  document.body.appendChild(popover);
  activeReactionsPopover = popover;
}

// Dismiss reactions popover on clicking outside
document.addEventListener('click', (e) => {
  if (activeReactionsPopover && !e.target.closest('.btn-react') && !e.target.closest('.reactions-popover')) {
    activeReactionsPopover.remove();
    activeReactionsPopover = null;
  }
});

// Socket Listeners for reactions and pins
socket.on('reactionUpdate', ({ messageId, reactions }) => {
  const container = document.querySelector(`.message-reactions-container[data-id="${messageId}"]`);
  if (container) {
    const newHtml = getReactionsHtml(messageId, reactions);
    const parent = container.parentElement;
    if (parent) {
      const temp = document.createElement('div');
      temp.innerHTML = newHtml;
      const newContainer = temp.firstElementChild;
      parent.replaceChild(newContainer, container);
    }
  }
});

socket.on('pinUpdate', ({ messageId, isPinned }) => {
  const msgElement = document.querySelector(`.message[data-msg-id="${messageId}"]`);
  if (msgElement) {
    // Update pin indicator in DOM
    const meta = msgElement.querySelector('.message-meta');
    if (meta) {
      let indicator = meta.querySelector('.pinned-indicator');
      if (isPinned) {
        if (!indicator) {
          const time = meta.querySelector('.message-time');
          const pinSpan = document.createElement('span');
          pinSpan.className = 'pinned-indicator';
          pinSpan.title = 'Pinned Message';
          pinSpan.textContent = '📌 Pinned';
          meta.insertBefore(pinSpan, time);
        }
      } else {
        if (indicator) {
          indicator.remove();
        }
      }
    }
    // Update tooltip/state of the pin button
    const pinBtn = msgElement.querySelector('.btn-pin');
    if (pinBtn) {
      pinBtn.title = isPinned ? 'Unpin Message' : 'Pin Message';
    }
  }
  
  // If pins panel is open, refresh it
  const pinsPanel = document.getElementById('pinned-messages-panel');
  if (pinsPanel && !pinsPanel.classList.contains('hidden')) {
    socket.emit('getPinnedMessages', { room: currentRoom });
  }
});

// Pinned Messages Panel Toggle
const pinsToggleBtn = document.getElementById('pins-toggle-btn');
const pinsPanel = document.getElementById('pinned-messages-panel');
const closePinsBtn = document.getElementById('close-pins-btn');
const pinnedMessagesList = document.getElementById('pinned-messages-list');

if (pinsToggleBtn && pinsPanel) {
  pinsToggleBtn.addEventListener('click', () => {
    pinsPanel.classList.toggle('hidden');
    pinsToggleBtn.classList.toggle('active');
    if (!pinsPanel.classList.contains('hidden')) {
      socket.emit('getPinnedMessages', { room: currentRoom });
    }
  });
}

if (closePinsBtn && pinsPanel) {
  closePinsBtn.addEventListener('click', () => {
    pinsPanel.classList.add('hidden');
    if (pinsToggleBtn) pinsToggleBtn.classList.remove('active');
  });
}

socket.on('pinnedMessages', ({ room, results }) => {
  if (room !== currentRoom) return;
  pinnedMessagesList.innerHTML = '';
  if (results.length === 0) {
    pinnedMessagesList.innerHTML = `<div class="no-pins">No pinned messages in this room yet.</div>`;
    return;
  }
  
  results.forEach(msg => {
    const pinItem = document.createElement('div');
    pinItem.className = 'pinned-message-item';
    pinItem.setAttribute('data-id', msg.id);
    
    let content = '';
    if (msg.fileUrl) {
      content = msg.text ? `[File] ${escapeHTML(msg.fileName)} - ${escapeHTML(msg.text)}` : `[File] ${escapeHTML(msg.fileName)}`;
    } else {
      content = formatMessageText(msg.text);
    }
    
    pinItem.innerHTML = `
      <div class="pin-item-meta">
        <span class="pin-item-sender">${escapeHTML(msg.username)}</span>
        <span class="pin-item-time">${msg.time}</span>
      </div>
      <div class="pin-item-body">${content}</div>
      <button class="unpin-item-btn" data-id="${msg.id}" title="Unpin Message">&times;</button>
    `;
    
    // Click on pin item scrolls to that message in the timeline
    pinItem.addEventListener('click', (e) => {
      if (e.target.closest('.unpin-item-btn')) {
        socket.emit('togglePinMessage', { messageId: msg.id });
        return;
      }
      const targetBubble = document.querySelector(`.message[data-msg-id="${msg.id}"] .message-bubble`);
      if (targetBubble) {
        targetBubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetBubble.classList.add('highlight-flash');
        setTimeout(() => targetBubble.classList.remove('highlight-flash'), 2000);
      }
    });
    
    pinnedMessagesList.appendChild(pinItem);
  });
  
  // Trigger syntax highlighting inside pinned list
  pinnedMessagesList.querySelectorAll('pre code').forEach((el) => {
    hljs.highlightElement(el);
  });
});

// Autocomplete suggestions for mentions
const mentionSuggestions = document.getElementById('mention-suggestions');

if (msgInput) {
  msgInput.addEventListener('input', (e) => {
    const text = msgInput.value;
    const caretPos = msgInput.selectionStart;
    
    // Find the word currently being typed before the caret
    const textBeforeCaret = text.substring(0, caretPos);
    const lastWordMatch = textBeforeCaret.match(/@([a-zA-Z0-9 _-]*)$/);
    
    if (lastWordMatch) {
      const query = lastWordMatch[1].toLowerCase();
      // Filter active members from allUsers (except ourselves)
      const matches = allUsers.filter(u => 
        u.username.toLowerCase() !== username.toLowerCase() && 
        u.username.toLowerCase().startsWith(query)
      );
      
      if (matches.length > 0) {
        renderMentionSuggestions(matches, lastWordMatch.index, caretPos);
      } else {
        mentionSuggestions.classList.add('hidden');
      }
    } else {
      mentionSuggestions.classList.add('hidden');
    }
  });
}

function renderMentionSuggestions(users, startIndex, endIndex) {
  mentionSuggestions.innerHTML = users.map(user => {
    const initials = getInitials(user.username);
    const color = user.avatarColor || getAvatarColor(user.username);
    return `
      <div class="mention-suggestion-item" data-username="${escapeHTML(user.username)}" data-start="${startIndex}" data-end="${endIndex}">
        <div class="user-avatar" style="background: ${color}; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 600; color: white; margin-right: 8px;">${initials}</div>
        <span class="mention-suggestion-name">${escapeHTML(user.username)}</span>
      </div>
    `;
  }).join('');
  
  mentionSuggestions.classList.remove('hidden');
}

// Listen to click on suggestion item
if (mentionSuggestions) {
  mentionSuggestions.addEventListener('click', (e) => {
    const item = e.target.closest('.mention-suggestion-item');
    if (!item) return;
    
    const selectedName = item.dataset.username;
    const start = parseInt(item.dataset.start, 10);
    const end = parseInt(item.dataset.end, 10);
    
    const text = msgInput.value;
    const newText = text.substring(0, start) + `@${selectedName} ` + text.substring(end);
    
    msgInput.value = newText;
    mentionSuggestions.classList.add('hidden');
    msgInput.focus();
  });
}

// Receive Mentions Notifications from Server
socket.on('mentionNotification', ({ sender, room, text, messageId }) => {
  if (window.Notification && Notification.permission === 'granted') {
    new Notification(`@Mentioned by ${sender}`, {
      body: text,
      icon: '/favicon.ico'
    });
  }
  playDingSound();
  showMentionToast(sender, room, text, messageId);
});

function showMentionToast(sender, room, text, messageId) {
  const toast = document.createElement('div');
  toast.className = 'mention-toast';
  toast.innerHTML = `
    <div class="toast-header">
      <span>📌 Mentioned by <strong>${escapeHTML(sender)}</strong> in #${room.startsWith('dm:') ? 'Direct Message' : room}</span>
      <button class="close-toast-btn">&times;</button>
    </div>
    <div class="toast-body">${escapeHTML(text)}</div>
  `;
  
  toast.addEventListener('click', (e) => {
    if (e.target.closest('.close-toast-btn')) {
      toast.remove();
      return;
    }
    
    if (room.startsWith('dm:')) {
      startDM(sender);
    } else {
      const roomItem = document.querySelector(`#rooms-list li[data-room="${room}"]`);
      if (roomItem) roomItem.click();
    }
    
    setTimeout(() => {
      const targetBubble = document.querySelector(`.message[data-msg-id="${messageId}"] .message-bubble`);
      if (targetBubble) {
        targetBubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetBubble.classList.add('highlight-flash');
        setTimeout(() => targetBubble.classList.remove('highlight-flash'), 2000);
      }
    }, 500);
    
    toast.remove();
  });
  
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('show');
  }, 50);
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

// Message forwarding modal functionality
let forwardTargetMessageId = null;
const forwardModal = document.getElementById('forward-modal');
const forwardCancelBtn = document.getElementById('forward-cancel-btn');
const forwardRoomsList = document.getElementById('forward-rooms-list');
const forwardUsersList = document.getElementById('forward-users-list');

function openForwardModal(messageId) {
  forwardTargetMessageId = messageId;
  
  // Populate list of rooms
  forwardRoomsList.innerHTML = Object.keys(roomMetadata).map(roomName => {
    const meta = roomMetadata[roomName];
    return `
      <li class="forward-target-item" data-room="${escapeHTML(roomName)}">
        <span>${meta.icon}</span>
        <span>${escapeHTML(roomName)}</span>
      </li>
    `;
  }).join('');
  
  // Populate list of active users (excluding ourselves)
  forwardUsersList.innerHTML = allUsers
    .filter(u => u.username.toLowerCase() !== username.toLowerCase())
    .map(u => {
      const initials = getInitials(u.username);
      const color = u.avatarColor || getAvatarColor(u.username);
      return `
        <li class="forward-target-item" data-username="${escapeHTML(u.username)}">
          <div class="user-avatar" style="background: ${color}; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 600; color: white; margin-right: 8px;">${initials}</div>
          <span>${escapeHTML(u.username)}</span>
        </li>
      `;
    }).join('');
    
  forwardModal.classList.remove('hidden');
}

if (forwardCancelBtn) {
  forwardCancelBtn.addEventListener('click', () => {
    forwardModal.classList.add('hidden');
    forwardTargetMessageId = null;
  });
}

function handleForwardSelect(targetRoomName) {
  if (!forwardTargetMessageId) return;
  
  const originalMsg = loadedMessages.get(forwardTargetMessageId);
  if (originalMsg) {
    const forwardPayload = {
      text: originalMsg.text || '',
      room: targetRoomName
    };
    if (originalMsg.fileUrl) {
      forwardPayload.file = {
        url: originalMsg.fileUrl,
        name: originalMsg.fileName,
        type: originalMsg.fileType,
        size: originalMsg.fileSize
      };
    }
    
    socket.emit('chatMessage', forwardPayload);
  }
  
  forwardModal.classList.add('hidden');
  forwardTargetMessageId = null;
}

if (forwardRoomsList) {
  forwardRoomsList.addEventListener('click', (e) => {
    const item = e.target.closest('.forward-target-item');
    if (!item) return;
    handleForwardSelect(item.dataset.room);
  });
}

if (forwardUsersList) {
  forwardUsersList.addEventListener('click', (e) => {
    const item = e.target.closest('.forward-target-item');
    if (!item) return;
    
    const targetKey = item.dataset.username.toLowerCase();
    const sorted = [username.toLowerCase(), targetKey].sort();
    const dmRoom = `dm:${sorted[0]}:${sorted[1]}`;
    handleForwardSelect(dmRoom);
  });
}

// Receive general moderation errors from the server
socket.on('moderationError', (message) => {
  alert(`Moderation Error: ${message}`);
});

socket.on('deleteRoomError', (message) => {
  alert(`Room Deletion Error: ${message}`);
});

// =====================================================================
// MISSING SOCKET HANDLERS & HELPERS
// =====================================================================

function switchToRoom(targetRoom, roomPassword) {
  currentRoom = targetRoom;
  updateRoomHeader(currentRoom);
  messagesContainer.innerHTML = '';
  typingUsers.clear();
  updateTypingIndicator();
  const roomsListContainer = document.getElementById('rooms-list');
  if (roomsListContainer) {
    roomsListContainer.querySelectorAll('li').forEach(li => {
      li.classList.toggle('active', li.dataset.room === targetRoom);
    });
  }
  document.querySelectorAll('.member-item').forEach(li => li.classList.remove('active'));
  socket.emit('joinRoom', { username, room: currentRoom, roomPassword: roomPassword || undefined });
}

// 2. Room password modal
let pendingRoomSwitch = null;
const roomPasswordModal = document.getElementById('room-password-modal');
const roomPasswordForm = document.getElementById('room-password-form');
const joinRoomPasswordInput = document.getElementById('join-room-password-input');
const roomPasswordCancelBtn = document.getElementById('room-password-cancel-btn');

if (roomPasswordForm) {
  roomPasswordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pwd = joinRoomPasswordInput ? joinRoomPasswordInput.value.trim() : '';
    if (!pwd || !pendingRoomSwitch) return;
    if (roomPasswordModal) roomPasswordModal.classList.add('hidden');
    switchToRoom(pendingRoomSwitch, pwd);
    pendingRoomSwitch = null;
  });
}
if (roomPasswordCancelBtn) {
  roomPasswordCancelBtn.addEventListener('click', () => {
    if (roomPasswordModal) roomPasswordModal.classList.add('hidden');
    pendingRoomSwitch = null;
  });
}

// 3. Create room
const openCreateRoomBtn = document.getElementById('open-create-room-btn');
const createRoomModal = document.getElementById('create-room-modal');
const createRoomForm = document.getElementById('create-room-form');
const createRoomCancelBtn = document.getElementById('create-room-cancel-btn');
const createRoomError = document.getElementById('create-room-error');

if (openCreateRoomBtn) {
  openCreateRoomBtn.addEventListener('click', () => {
    if (createRoomModal) createRoomModal.classList.remove('hidden');
    if (createRoomError) { createRoomError.textContent = ''; createRoomError.classList.add('hidden'); }
    if (createRoomForm) createRoomForm.reset();
  });
}
if (createRoomCancelBtn) {
  createRoomCancelBtn.addEventListener('click', () => {
    if (createRoomModal) createRoomModal.classList.add('hidden');
  });
}
if (createRoomForm) {
  createRoomForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('room-name-input')?.value.trim() || '';
    const description = document.getElementById('room-desc-input')?.value.trim() || '';
    const password = document.getElementById('room-password-input')?.value.trim() || '';
    const maxCapacity = parseInt(document.getElementById('room-capacity-input')?.value, 10) || 100;
    if (!name) return;
    if (createRoomError) { createRoomError.textContent = ''; createRoomError.classList.add('hidden'); }
    socket.emit('createRoom', { name, description, password, maxCapacity });
  });
}

socket.on('createRoomSuccess', ({ roomName }) => {
  if (createRoomModal) createRoomModal.classList.add('hidden');
  if (createRoomForm) createRoomForm.reset();
  switchToRoom(roomName, null);
});

socket.on('createRoomError', (message) => {
  if (createRoomError) {
    createRoomError.textContent = message;
    createRoomError.classList.remove('hidden');
  }
});

// 4. Forced lobby redirect (kick/ban/room delete)
socket.on('forcedJoinLobby', ({ message: reason }) => {
  alert(reason);
  currentRoom = 'Lobby';
  updateRoomHeader('Lobby');
  messagesContainer.innerHTML = '';
  typingUsers.clear();
  updateTypingIndicator();
  localStorage.setItem('aetherchat_room', 'Lobby');
  const roomsListContainer = document.getElementById('rooms-list');
  if (roomsListContainer) {
    roomsListContainer.querySelectorAll('li').forEach(li => {
      li.classList.toggle('active', li.dataset.room === 'Lobby');
    });
  }
});

// 5. Room users count
socket.on('roomUsers', ({ room, users }) => {
  const roomsListContainer = document.getElementById('rooms-list');
  if (!roomsListContainer) return;
  const roomItem = roomsListContainer.querySelector(`li[data-room="${room}"]`);
  if (roomItem) {
    let badge = roomItem.querySelector('.badge');
    if (users.length > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'badge';
        roomItem.appendChild(badge);
      }
      badge.textContent = users.length;
    } else if (badge) { badge.remove(); }
  }
});

// 6. Muted notification
socket.on('mutedNotification', ({ room: mutedRoom, duration }) => {
  alert(`You have been muted in "${mutedRoom}" for ${duration} seconds.`);
});
