/**
 * Moments (Temporary Updates) Logic
 * 
 * Handles fetching, displaying, uploading, and interacting with Moments.
 */

window.SDH = window.SDH || {};

SDH.Moments = (function() {
    let momentsData = []; // Array of { user_id, username, moments: [] }
    let currentUserId = null;
    let currentMomentIndex = 0;
    let progressTimer = null;
    let currentAudio = null;
    const MOMENT_DURATION = 30000; // 30 seconds standard duration per story/moment
    let countdownTimer = null;

    // Keep track of viewed moments in localStorage
    let viewedMomentsKey = 'sdh_viewed_moments';
    let viewedMoments = {};

    // Privacy settings state
    let privacySettings = {
        privacy_type: 'all',
        custom_user_ids: [],
        friends: []
    };
    let uploadPrivacyType = null;
    let uploadCustomUserIds = null;
    let isFromUploadModal = false;

    // Self-contained SVG avatar generator to prevent broken image icons
    function getSvgAvatar(name) {
        const cleanName = (name || 'U').trim();
        const initial = (cleanName.charAt(0) || 'U').toUpperCase();
        const colors = [
            ['#6366f1', '#4338ca'],
            ['#8b5cf6', '#6d28d9'],
            ['#ec4899', '#be185d'],
            ['#f59e0b', '#b45309'],
            ['#10b981', '#047857'],
            ['#06b6d4', '#0e7490'],
            ['#3b82f6', '#1d4ed8']
        ];
        const charCode = initial.charCodeAt(0) || 0;
        const [col1, col2] = colors[charCode % colors.length];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><linearGradient id="mg_${charCode}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${col1}"/><stop offset="100%" stop-color="${col2}"/></linearGradient></defs><circle cx="50" cy="50" r="50" fill="url(#mg_${charCode})"/><text x="50" y="55%" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="44" font-weight="700">${initial}</text></svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }
    let tempSelectedUserIds = new Set();
    let tempPrivacyType = 'all';

    function init() {
        viewedMomentsKey = `sdh_viewed_moments_${window.SDH_DATA.currentUserId}`;
        viewedMoments = JSON.parse(localStorage.getItem(viewedMomentsKey) || '{}');
        fetchMoments();
        loadPrivacySettings();
        _initMentionInputs();
        
        // Listen for websocket events from Chat
        document.addEventListener('sdh_ws_message', function(e) {
            const data = e.detail;
            if (data.type === 'new_moment') {
                handleNewMomentEvent(data.moment);
            } else if (data.type === 'delete_moment') {
                handleDeleteMomentEvent(data.user_id, data.moment_id);
            } else if (data.type === 'moment_viewed') {
                handleMomentViewedEvent(data.moment_id, data.viewer);
            } else if (data.type === 'moment_reacted') {
                handleMomentReactedEvent(data.moment_id, data.reaction);
            }
        });
    }

    function _initMentionInputs() {
        if (!window.SDH?.Mentions) return;
        const muCaption = document.getElementById('muCaption');
        if (muCaption) window.SDH.Mentions.attach(muCaption, { getContext: () => ({ isMoments: true }) });
        const muText = document.getElementById('muTextContent');
        if (muText) window.SDH.Mentions.attach(muText, { getContext: () => ({ isMoments: true }) });
        const mvReply = document.getElementById('mvReplyInput');
        if (mvReply) {
            window.SDH.Mentions.attach(mvReply, {
                getContext: () => {
                    const userGroup = momentsData.find(g => g.user_id === currentUserId);
                    return { isMoments: true, author: userGroup ? userGroup.username : null };
                }
            });
        }
    }

    function markViewed(momentId) {
        viewedMoments[momentId] = true;
        localStorage.setItem(viewedMomentsKey, JSON.stringify(viewedMoments));
    }

    function isSeen(moment) {
        return !!viewedMoments[moment.id];
    }

    function isAllSeenForUser(userGroup) {
        return userGroup.moments.every(isSeen);
    }

    async function fetchMoments() {
        try {
            const res = await fetch('/messaging/api/moments/');
            if (!res.ok) return;
            const json = await res.json();
            if (json.status === 'ok') {
                momentsData = json.data;
                renderTray();
            }
        } catch (e) {
            console.error("Failed to fetch moments", e);
        }
    }

    function renderTray() {
        const trayContainer = document.getElementById('momentsTrayContainer');
        const tray = document.getElementById('momentsTray');
        const sidebarTray = document.getElementById('sidebarMomentsTray');
        if (!tray && !sidebarTray) return;

        const myId = String(window.SDH_DATA?.currentUserId || '');
        const myGroup = momentsData.find(g => String(g.user_id) === myId || g.username === window.SDH_DATA?.currentUser);
        const myAvatar = window.SDH_DATA?.currentUserAvatar || (myGroup && myGroup.avatar_url) || getSvgAvatar(window.SDH_DATA?.currentUser || 'You');

        // Build "Your Story" element
        let myStoryHtml = '';
        if (myGroup && myGroup.moments && myGroup.moments.length > 0) {
            const isSeen = isAllSeenForUser(myGroup);
            const ringClass = isSeen ? 'moment-ring-seen' : 'moment-ring';
            myStoryHtml = `
                <div class="flex flex-col items-center gap-1 cursor-pointer w-16 flex-shrink-0 group" onclick="SDH.Moments.openViewer(${myGroup.user_id})">
                    <div class="relative">
                        <div class="${ringClass} p-[2px] transition-transform group-hover:scale-105">
                            <img src="${myAvatar}" class="w-12 h-12 rounded-full border-2 border-divine-card object-cover bg-slate-100 dark:bg-divine-surface" onerror="this.onerror=null; this.src='${getSvgAvatar(window.SDH_DATA?.currentUser || 'You')}';" />
                        </div>
                        <button type="button" onclick="event.stopPropagation(); SDH.Moments.showUploadModal();" title="Add another story" class="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-divine-gold text-black flex items-center justify-center font-bold text-xs shadow-md border-2 border-divine-card hover:scale-110 transition-transform">
                            +
                        </button>
                    </div>
                    <span class="text-[10px] text-slate-800 dark:text-white/90 font-medium w-full truncate text-center group-hover:text-divine-gold transition-colors">Your Story</span>
                </div>
            `;
        } else {
            myStoryHtml = `
                <div class="flex flex-col items-center gap-1 cursor-pointer w-16 flex-shrink-0 group" onclick="SDH.Moments.showUploadModal()">
                    <div class="relative">
                        <div class="p-[2px] rounded-full border-2 border-dashed border-divine-gold/60 group-hover:border-divine-gold transition-colors">
                            <img src="${myAvatar}" class="w-12 h-12 rounded-full border-2 border-divine-card object-cover bg-slate-100 dark:bg-divine-surface opacity-85 group-hover:opacity-100 transition-opacity" onerror="this.onerror=null; this.src='${getSvgAvatar(window.SDH_DATA?.currentUser || 'You')}';" />
                        </div>
                        <div class="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-divine-gold text-black flex items-center justify-center font-bold text-xs shadow-md border-2 border-divine-card group-hover:scale-110 transition-transform">
                            +
                        </div>
                    </div>
                    <span class="text-[10px] text-slate-600 dark:text-divine-muted group-hover:text-divine-gold font-medium w-full truncate text-center transition-colors">Add Story</span>
                </div>
            `;
        }

        // Friends' stories (excluding myGroup)
        const friendsGroups = momentsData.filter(g => String(g.user_id) !== myId && g.username !== window.SDH_DATA?.currentUser);
        friendsGroups.sort((a, b) => {
            const aSeen = isAllSeenForUser(a);
            const bSeen = isAllSeenForUser(b);
            if (aSeen === bSeen) return a.username.localeCompare(b.username);
            return aSeen ? 1 : -1;
        });

        let friendsHtml = '';
        friendsGroups.forEach(userGroup => {
            const ringClass = isAllSeenForUser(userGroup) ? 'moment-ring-seen' : 'moment-ring';
            const defaultAvatar = getSvgAvatar(userGroup.username);
            const avatarUrl = userGroup.avatar_url || (userGroup.moments[0] && userGroup.moments[0].moment_type === 'image' ? userGroup.moments[0].media_url : null) || defaultAvatar;

            friendsHtml += `
                <div class="flex flex-col items-center gap-1 cursor-pointer w-16 flex-shrink-0 group" onclick="SDH.Moments.openViewer(${userGroup.user_id})">
                    <div class="${ringClass} p-[2px] transition-transform group-hover:scale-105">
                        <img src="${avatarUrl}" class="w-12 h-12 rounded-full border-2 border-divine-card object-cover bg-slate-100 dark:bg-divine-surface" onerror="this.onerror=null; this.src='${defaultAvatar}';" />
                    </div>
                    <span class="text-[10px] text-slate-800 dark:text-white/80 w-full truncate text-center group-hover:text-divine-gold transition-colors">${userGroup.username}</span>
                </div>
            `;
        });

        const fullTrayHtml = myStoryHtml + friendsHtml;

        // Populate sidebar tray
        if (sidebarTray) {
            sidebarTray.innerHTML = fullTrayHtml;
        }

        // Populate header chat panel tray
        if (tray && trayContainer) {
            tray.innerHTML = fullTrayHtml;
            if (momentsData.length === 0) {
                trayContainer.classList.add('hidden');
            } else {
                trayContainer.classList.remove('hidden');
            }
        }
    }

    function handleNewMomentEvent(moment) {
        let userGroup = momentsData.find(g => g.user_id === moment.user_id);
        if (!userGroup) {
            userGroup = {
                user_id: moment.user_id,
                username: moment.username,
                avatar_url: moment.avatar_url || null,
                moments: []
            };
            momentsData.push(userGroup);
        } else if (moment.avatar_url && !userGroup.avatar_url) {
            userGroup.avatar_url = moment.avatar_url;
        }
        
        // Prevent duplicate moments from being added (e.g. from AJAX upload response + WS event)
        const existingIndex = userGroup.moments.findIndex(m => m.id == moment.id);
        if (existingIndex > -1) {
            userGroup.moments[existingIndex] = moment;
        } else {
            userGroup.moments.push(moment);
        }
        // Resort and render
        userGroup.moments.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
        renderTray();
    }

    function handleDeleteMomentEvent(userId, momentId) {
        const userGroup = momentsData.find(g => g.user_id === userId);
        if (userGroup) {
            userGroup.moments = userGroup.moments.filter(m => m.id !== momentId);
            if (userGroup.moments.length === 0) {
                momentsData = momentsData.filter(g => g.user_id !== userId);
            }
            renderTray();
            
            // If viewer is currently open and looking at this user
            if (currentUserId === userId) {
                if (userGroup.moments.length === 0) {
                    closeViewer();
                } else {
                    if (currentMomentIndex >= userGroup.moments.length) {
                        currentMomentIndex = userGroup.moments.length - 1;
                    }
                    playMoment();
                }
            }
        }
    }

    function handleMomentViewedEvent(momentId, viewer) {
        const myUserId = parseInt(window.SDH_DATA.currentUserId);
        const userGroup = momentsData.find(g => g.user_id === myUserId);
        if (userGroup) {
            const moment = userGroup.moments.find(m => m.id === momentId);
            if (moment) {
                moment.viewers = moment.viewers || [];
                if (!moment.viewers.some(v => v.id === viewer.id)) {
                    moment.viewers.push(viewer);
                    if (currentUserId === myUserId) {
                        const currentMoment = userGroup.moments[currentMomentIndex];
                        if (currentMoment && currentMoment.id === momentId) {
                            document.getElementById('mvViewsCount').innerText = moment.viewers.length;
                            const overlay = document.getElementById('mvViewsOverlay');
                            if (overlay && !overlay.classList.contains('hidden')) {
                                const list = document.getElementById('mvViewsList');
                                if (moment.viewers.length === 1) {
                                    list.innerHTML = '';
                                }
                                list.insertAdjacentHTML('beforeend', `
                                    <div class="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl cursor-default transition-colors">
                                        <img src="${viewer.avatar}" class="w-10 h-10 rounded-full border border-white/10 object-cover" />
                                        <span class="text-sm font-semibold text-white/90">${viewer.username}</span>
                                    </div>
                                `);
                            }
                        }
                    }
                    renderTray();
                }
            }
        }
    }

    function handleMomentReactedEvent(momentId, reaction) {
        const myUserId = parseInt(window.SDH_DATA.currentUserId);
        const userGroup = momentsData.find(g => g.user_id === myUserId);
        if (userGroup) {
            const moment = userGroup.moments.find(m => m.id === momentId);
            if (moment) {
                moment.reactions = moment.reactions || [];
                // Update or add reaction
                moment.reactions = moment.reactions.filter(r => r.user_id != reaction.user_id);
                moment.reactions.push(reaction);
                
                // If we are currently watching this moment, show the reaction floating up!
                if (currentUserId === myUserId) {
                    const currentMoment = userGroup.moments[currentMomentIndex];
                    if (currentMoment && currentMoment.id === momentId) {
                        // Float the emoji (Instagram Live style)
                        const floater = document.createElement('div');
                        floater.innerText = reaction.emoji;
                        // Randomize horizontal position slightly to make it look organic
                        const randomX = 40 + Math.random() * 20; // 40% to 60%
                        floater.className = 'fixed bottom-24 text-5xl animate-float-up pointer-events-none z-[100]';
                        floater.style.left = `${randomX}%`;
                        document.body.appendChild(floater);
                        setTimeout(() => floater.remove(), 1500);
                        
                        // Update views modal list if open
                        const overlay = document.getElementById('mvViewsOverlay');
                        if (overlay && !overlay.classList.contains('hidden')) {
                            showViews();
                        }
                    }
                }
            }
        }
    }

    // ─── UPLOAD MODAL ─────────────────────────────────────────────────────────

    function showUploadModal() {
        document.getElementById('momentUploadModal').classList.remove('hidden');
        document.getElementById('muType').value = 'image';
        document.getElementById('muSongFile').value = '';
        clearMediaSelection();
        clearSpotifySelection();
        setSoundtrackMode('upload');
        toggleUploadFields();
        uploadPrivacyType = privacySettings.privacy_type;
        uploadCustomUserIds = [...privacySettings.custom_user_ids];
        updateUploadPrivacyBadge();
        _initMentionInputs();
    }

    function toggleUploadFields() {
        const type = document.getElementById('muType').value;
        const mediaGroup = document.getElementById('muMediaGroup');
        const textGroup = document.getElementById('muTextGroup');
        const fileInput = document.getElementById('muFile');
        const durationNotice = document.getElementById('muDurationNotice');

        if (type === 'text') {
            mediaGroup.classList.add('hidden');
            textGroup.classList.remove('hidden');
            clearMediaSelection();
        } else {
            mediaGroup.classList.remove('hidden');
            textGroup.classList.add('hidden');
            if (type === 'image') {
                fileInput.accept = 'image/*';
            }
            if (type === 'video') {
                fileInput.accept = 'video/*';
            }
        }
    }

    function handleMediaSelection(input) {
        const file = input && input.files && input.files[0];
        const previewBox = document.getElementById('muMediaPreviewBox');
        const img = document.getElementById('muPreviewImg');
        const vid = document.getElementById('muPreviewVid');
        const nameEl = document.getElementById('muPreviewFileName');
        const durationBadge = document.getElementById('muPreviewDurationBadge');
        const typeBadge = document.getElementById('muPreviewTypeBadge');
        const infoEl = document.getElementById('muPreviewInfo');

        if (!file) {
            clearMediaSelection();
            return;
        }

        if (nameEl) nameEl.innerText = file.name;
        if (img) { img.classList.add('hidden'); img.src = ''; }
        if (vid) { vid.classList.add('hidden'); vid.src = ''; }

        if (file.type.startsWith('video/')) {
            document.getElementById('muType').value = 'video';
            if (typeBadge) typeBadge.innerText = 'Video';
            const videoUrl = URL.createObjectURL(file);
            if (vid) {
                vid.src = videoUrl;
                vid.classList.remove('hidden');
            }
            if (previewBox) previewBox.classList.remove('hidden');
        } else if (file.type.startsWith('image/')) {
            document.getElementById('muType').value = 'image';
            if (typeBadge) typeBadge.innerText = 'Photo';
            const imgUrl = URL.createObjectURL(file);
            if (img) {
                img.src = imgUrl;
                img.classList.remove('hidden');
            }
            if (previewBox) previewBox.classList.remove('hidden');
        } else {
            if (previewBox) previewBox.classList.add('hidden');
        }
    }

    function clearMediaSelection() {
        const fileInput = document.getElementById('muFile');
        if (fileInput) fileInput.value = '';
        const previewBox = document.getElementById('muMediaPreviewBox');
        if (previewBox) previewBox.classList.add('hidden');
        const img = document.getElementById('muPreviewImg');
        if (img) { img.src = ''; img.classList.add('hidden'); }
        const vid = document.getElementById('muPreviewVid');
        if (vid) { vid.src = ''; vid.classList.add('hidden'); }
    }

    // ─── SOUNDTRACK UI ────────────────────────────────────────────────────────
    
    function setSoundtrackMode(mode, fromUserClick = false) {
        const upGrp = document.getElementById('stUploadGroup');
        const spGrp = document.getElementById('stSpotifyGroup');
        const btnUp = document.getElementById('btnStUpload');
        const btnSp = document.getElementById('btnStSpotify');
        
        if (mode === 'upload') {
            // If already in upload mode, clicking it should open the file picker
            if (fromUserClick && !upGrp.classList.contains('hidden')) {
                const songInput = document.getElementById('muSongFile');
                if (songInput) songInput.click();
            }
            
            upGrp.classList.remove('hidden');
            spGrp.classList.add('hidden');
            btnUp.className = "flex-1 text-xs py-1.5 rounded-lg border border-divine-gold text-divine-gold bg-divine-gold/10 transition-all duration-200 active:scale-95 active:bg-divine-gold/20";
            btnSp.className = "flex-1 text-xs py-1.5 rounded-lg border border-divine-border text-divine-muted bg-transparent transition-all duration-200 active:scale-95 active:bg-divine-gold/10";
            clearSpotifySelection();
        } else {
            upGrp.classList.add('hidden');
            spGrp.classList.remove('hidden');
            btnSp.className = "flex-1 text-xs py-1.5 rounded-lg border border-divine-gold text-divine-gold bg-divine-gold/10 transition-all duration-200 active:scale-95 active:bg-divine-gold/20";
            btnUp.className = "flex-1 text-xs py-1.5 rounded-lg border border-divine-border text-divine-muted bg-transparent transition-all duration-200 active:scale-95 active:bg-divine-gold/10";
            document.getElementById('muSongFile').value = '';
            if (fromUserClick && window.SDH?.showComingSoon) {
                window.SDH.showComingSoon('Spotify integration');
            }
        }
    }

    function searchSpotify(query) {
        clearTimeout(searchTimeout);
        const resultsDiv = document.getElementById('spotifyResults');
        
        if (!query.trim()) {
            resultsDiv.classList.add('hidden');
            return;
        }

        searchTimeout = setTimeout(async () => {
            try {
                const res = await fetch(`/messaging/api/spotify/search/?q=${encodeURIComponent(query)}`);
                const data = await res.json();
                
                resultsDiv.innerHTML = '';
                if (data.tracks && data.tracks.length > 0) {
                    data.tracks.forEach(track => {
                        const div = document.createElement('div');
                        div.className = "flex items-center gap-2 p-2 hover:bg-white/10 cursor-pointer rounded-lg";
                        div.onclick = () => selectSpotifyTrack(track);
                        div.innerHTML = `
                            <img src="${track.album_art || ''}" class="w-8 h-8 rounded object-cover" />
                            <div class="flex-1 min-w-0">
                                <p class="text-xs text-white truncate">${track.title}</p>
                                <p class="text-[10px] text-white/50 truncate">${track.artist}</p>
                            </div>
                        `;
                        resultsDiv.appendChild(div);
                    });
                    resultsDiv.classList.remove('hidden');
                } else {
                    resultsDiv.classList.add('hidden');
                }
            } catch (e) {
                console.error(e);
            }
        }, 300);
    }

    function selectSpotifyTrack(track) {
        document.getElementById('spotifyResults').classList.add('hidden');
        document.getElementById('muSpotifySearch').value = '';
        document.getElementById('muSpotifySearch').classList.add('hidden');
        
        const selected = document.getElementById('spotifySelected');
        selected.classList.remove('hidden');
        document.getElementById('spotifyThumb').src = track.album_art || '';
        document.getElementById('spotifyTitle').innerText = track.title;
        document.getElementById('spotifyArtist').innerText = track.artist;
        
        document.getElementById('muSpotifyId').value = track.id;
        document.getElementById('muSpotifyInfo').value = JSON.stringify(track);
    }

    function clearSpotifySelection() {
        document.getElementById('spotifySelected').classList.add('hidden');
        document.getElementById('muSpotifySearch').classList.remove('hidden');
        document.getElementById('muSpotifySearch').value = '';
        document.getElementById('muSpotifyId').value = '';
        document.getElementById('muSpotifyInfo').value = '';
    }

    function updateSoundtrackFile(input) {
        const container = document.getElementById('stSelectedFileContainer');
        const nameSpan = document.getElementById('stSelectedFileName');
        if (input.files && input.files.length > 0) {
            nameSpan.innerText = input.files[0].name;
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
            nameSpan.innerText = '';
        }
    }

    function clearSoundtrackFile() {
        const input = document.getElementById('muSongFile');
        if (input) input.value = '';
        updateSoundtrackFile(input);
    }

    async function uploadMoment() {
        const btn = document.getElementById('muSubmitBtn');
        btn.disabled = true;
        btn.innerText = 'Sharing...';

        const type = document.getElementById('muType').value;
        const caption = document.getElementById('muCaption').value;
        const textContent = document.getElementById('muTextContent').value;
        const fileInput = document.getElementById('muFile');

        const formData = new FormData();
        formData.append('moment_type', type);
        formData.append('caption', caption);
        
        // Include status privacy settings
        const privacyType = uploadPrivacyType || privacySettings.privacy_type;
        const customIds = uploadCustomUserIds !== null ? uploadCustomUserIds : privacySettings.custom_user_ids;
        formData.append('privacy_type', privacyType);
        formData.append('privacy_user_ids', JSON.stringify(customIds));
        
        if (type === 'text') {
            formData.append('text_content', textContent);
        } else {
            if (fileInput.files.length > 0) {
                formData.append('media', fileInput.files[0]);
            }
        }

        const songInput = document.getElementById('muSongFile');
        const spotifyId = document.getElementById('muSpotifyId').value;
        const spotifyInfo = document.getElementById('muSpotifyInfo').value;
        
        if (songInput.files.length > 0) {
            formData.append('song_file', songInput.files[0]);
        }
        if (spotifyId) {
            formData.append('spotify_track_id', spotifyId);
            formData.append('spotify_track_info', spotifyInfo);
        }

        try {
            const res = await fetch('/messaging/api/moments/upload/', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': window.SDH_DATA.csrfToken
                },
                body: formData
            });
            const json = await res.json();
            if (json.status === 'ok') {
                document.getElementById('momentUploadModal').classList.add('hidden');
                // The new moment will arrive via WS, but we can also handle it directly
                handleNewMomentEvent(json.moment);
                fetchMoments();
                window.SDH?.Chat?.showToast?.('Story posted successfully! ✨', 'success');
            } else {
                alert(json.error || 'Upload failed');
            }
        } catch (e) {
            console.error(e);
            alert('Upload failed');
        } finally {
            btn.disabled = false;
            btn.innerText = 'Share';
        }
    }

    // ─── VIEWER ───────────────────────────────────────────────────────────────

    function openViewer(userId) {
        currentUserId = parseInt(userId, 10);
        const userGroup = momentsData.find(g => g.user_id === currentUserId || String(g.user_id) === String(userId));
        if (!userGroup) return;

        // Find first unseen
        let startIndex = userGroup.moments.findIndex(m => !isSeen(m));
        currentMomentIndex = startIndex === -1 ? 0 : startIndex;

        const modal = document.getElementById('momentsViewerModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        _initMentionInputs();
        playMoment();
    }

    function closeViewer() {
        document.getElementById('momentsViewerModal').classList.add('hidden');
        document.getElementById('momentsViewerModal').classList.remove('flex');
        clearTimeout(progressTimer);
        clearInterval(countdownTimer);
        countdownTimer = null;
        const video = document.getElementById('mvVideo');
        video.pause();
        video.src = '';
        
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
        }

        currentUserId = null;
        renderTray(); // Update seen rings
    }

    function startCountdown(totalMs) {
        clearInterval(countdownTimer);
        const countdownEl = document.getElementById('mvCountdownText');
        if (!countdownEl) return;
        let remaining = Math.max(1, Math.round(totalMs / 1000));
        countdownEl.innerText = `${remaining}s`;

        countdownTimer = setInterval(() => {
            remaining--;
            if (remaining >= 0) {
                if (countdownEl) countdownEl.innerText = `${remaining}s`;
            } else {
                clearInterval(countdownTimer);
            }
        }, 1000);
    }

    function playMoment() {
        clearTimeout(progressTimer);
        clearInterval(countdownTimer);
        const userGroup = momentsData.find(g => g.user_id === currentUserId || String(g.user_id) === String(currentUserId));
        if (!userGroup || currentMomentIndex >= userGroup.moments.length) {
            // Reached end for this user, try next user
            moveToNextUser();
            return;
        }

        const moment = userGroup.moments[currentMomentIndex];

        // Hide error card if previously shown
        const errCard = document.getElementById('mvImageErrorCard');
        if (errCard) errCard.classList.add('hidden');

        // Update Header
        const defaultAvatar = getSvgAvatar(userGroup.username);
        const isSelf = String(userGroup.user_id) === String(window.SDH_DATA?.currentUserId) || userGroup.username === window.SDH_DATA?.currentUser;
        const avatarUrl = userGroup.avatar_url || (isSelf ? window.SDH_DATA?.currentUserAvatar : null) || (moment.moment_type === 'image' ? moment.media_url : null) || defaultAvatar;
        const mvAvatarEl = document.getElementById('mvAvatar');
        if (mvAvatarEl) {
            mvAvatarEl.src = avatarUrl;
            mvAvatarEl.onerror = function() {
                this.onerror = null;
                this.src = defaultAvatar;
            };
        }
        document.getElementById('mvUsername').innerText = isSelf ? `${userGroup.username} (You)` : userGroup.username;
        document.getElementById('mvTime').innerText = new Date(moment.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

        // Show/Hide Delete and Views buttons
        const isMine = isSelf;
        document.getElementById('mvDeleteBtn').classList.toggle('hidden', !isMine);
        
        const viewsBtn = document.getElementById('mvViewsBtn');
        viewsBtn.classList.toggle('hidden', !isMine);
        if (isMine) {
            moment.viewers = moment.viewers || [];
            document.getElementById('mvViewsCount').innerText = moment.viewers.length;
        }

        // Send view API if it's not mine and not already seen
        if (!isMine && !isSeen(moment)) {
            fetch(`/messaging/api/moments/${moment.id}/view/`, {
                method: 'POST',
                headers: {
                    'X-CSRFToken': window.SDH_DATA.csrfToken
                }
            }).catch(e => console.error("Failed to track view", e));
        }

        markViewed(moment.id);

        // Update Progress Bars
        const progressContainer = document.getElementById('momentProgressContainer');
        progressContainer.innerHTML = '';
        userGroup.moments.forEach((m, idx) => {
            let stateClass = '';
            if (idx < currentMomentIndex) stateClass = 'completed';
            else if (idx === currentMomentIndex) stateClass = 'active';
            
            progressContainer.insertAdjacentHTML('beforeend', `
                <div class="moment-bar ${stateClass}">
                    <div class="moment-bar-fill"></div>
                </div>
            `);
        });

        // Set Media
        const img = document.getElementById('mvImage');
        const vid = document.getElementById('mvVideo');
        const txt = document.getElementById('mvText');
        const caption = document.getElementById('mvCaption');

        img.classList.add('hidden');
        vid.classList.add('hidden');
        txt.classList.add('hidden');
        if (window.SDH?.Mentions?.format) {
            caption.innerHTML = window.SDH.Mentions.format(moment.caption || '');
        } else {
            caption.innerText = moment.caption || '';
        }
        
        // Reset active bar animation duration
        const activeBarFill = progressContainer.querySelector('.moment-bar.active .moment-bar-fill');

        const stOverlay = document.getElementById('mvSoundtrackOverlay');
        stOverlay.classList.add('hidden');
        
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
        }

        let audioUrl = moment.song_url;
        let trackInfo = moment.spotify_track_info;
        
        if (trackInfo && trackInfo.preview_url) {
            audioUrl = trackInfo.preview_url;
        }

        let audioDuration = MOMENT_DURATION; // Default 30s

        if (audioUrl) {
            currentAudio = new Audio(audioUrl);
            currentAudio.play().catch(e => {
                console.warn('Autoplay prevented:', e);
            });
            
            stOverlay.classList.remove('hidden');
            if (trackInfo) {
                document.getElementById('mvSoundtrackArt').src = trackInfo.album_art || '';
                document.getElementById('mvSoundtrackTitle').innerText = trackInfo.title;
                document.getElementById('mvSoundtrackArtist').innerText = trackInfo.artist;
            } else {
                document.getElementById('mvSoundtrackArt').src = 'https://ui-avatars.com/api/?name=🎵&background=random';
                document.getElementById('mvSoundtrackTitle').innerText = 'Uploaded Audio';
                document.getElementById('mvSoundtrackArtist').innerText = 'Custom Soundtrack';
            }
            
            // Limit audio to 30s to match story standard
            audioDuration = 30000;
        }

        const displayDuration = audioUrl ? audioDuration : MOMENT_DURATION; // 30,000ms = 30s

        // Reset Media Container background
        const mediaContainer = document.getElementById('mvMediaContainer');
        if (mediaContainer) {
            mediaContainer.style.background = '';
        }

        if (moment.moment_type === 'image') {
            if (mediaContainer) mediaContainer.style.background = '';
            if (!moment.media_url) {
                img.classList.add('hidden');
                const errCard = document.getElementById('mvImageErrorCard');
                if (errCard) {
                    errCard.classList.remove('hidden');
                    const errDesc = errCard.querySelector('p.text-xs');
                    if (errDesc) {
                        errDesc.textContent = isMine
                            ? 'Your story media expired or server container restarted. Tap + to upload a fresh story.'
                            : 'This story image is temporarily unavailable.';
                    }
                }
            } else {
                img.onerror = function() {
                    console.error("Failed to load moment image:", moment.media_url);
                    this.classList.add('hidden');
                    const errCard = document.getElementById('mvImageErrorCard');
                    if (errCard) {
                        errCard.classList.remove('hidden');
                        const errDesc = errCard.querySelector('p.text-xs');
                        if (errDesc) {
                            errDesc.textContent = isMine
                                ? 'Your story media expired or server container restarted. Tap + to upload a fresh story.'
                                : 'Could not load this story image.';
                        }
                    }
                };
                img.src = moment.media_url;
                img.classList.remove('hidden');
            }
            if (activeBarFill) activeBarFill.style.animationDuration = `${displayDuration}ms`;
            startCountdown(displayDuration);
            progressTimer = setTimeout(nextMoment, displayDuration);
        } else if (moment.moment_type === 'text') {
            if (window.SDH?.Mentions?.format) {
                txt.innerHTML = window.SDH.Mentions.format(moment.text_content || '');
            } else {
                txt.innerText = moment.text_content || '';
            }
            txt.classList.remove('hidden');
            document.getElementById('mvMediaContainer').style.background = `linear-gradient(135deg, hsl(${Math.random()*360}, 70%, 50%), hsl(${Math.random()*360}, 70%, 30%))`;
            if (activeBarFill) activeBarFill.style.animationDuration = `${displayDuration}ms`;
            startCountdown(displayDuration);
            progressTimer = setTimeout(nextMoment, displayDuration);
        } else if (moment.moment_type === 'video') {
            // Mute video if we have a soundtrack overriding it
            vid.muted = !!audioUrl; 
            
            // Set up handlers before setting src to avoid race conditions
            vid.onloadedmetadata = () => {
                let duration = Math.min((vid.duration * 1000) || MOMENT_DURATION, 30000); // 30s limit
                if (audioUrl) duration = audioDuration; // Audio duration takes precedence
                if (activeBarFill) activeBarFill.style.animationDuration = `${duration}ms`;
                clearTimeout(progressTimer);
                startCountdown(duration);
                progressTimer = setTimeout(nextMoment, duration);
            };

            vid.ontimeupdate = () => {
                // Enforce strict 30 second limit on video playback
                if (!audioUrl && vid.currentTime >= 30.0) {
                    clearTimeout(progressTimer);
                    clearInterval(countdownTimer);
                    nextMoment();
                }
            };

            vid.onended = () => {
                // If there's no custom soundtrack overriding, go to next moment immediately
                if (!audioUrl) {
                    clearTimeout(progressTimer);
                    clearInterval(countdownTimer);
                    nextMoment();
                }
            };

            vid.onerror = () => {
                console.error("Video failed to load, skipping to next moment.");
                clearTimeout(progressTimer);
                clearInterval(countdownTimer);
                progressTimer = setTimeout(nextMoment, 3000);
            };

            vid.src = moment.media_url;
            vid.classList.remove('hidden');
            
            vid.play().catch(e => {
                console.warn('Video autoplay prevented:', e);
            });
        }
    }

    function moveToNextUser() {
        const currentIndex = momentsData.findIndex(g => g.user_id === currentUserId);
        if (currentIndex !== -1 && currentIndex + 1 < momentsData.length) {
            openViewer(momentsData[currentIndex + 1].user_id);
        } else {
            closeViewer();
        }
    }

    function moveToPrevUser() {
        const currentIndex = momentsData.findIndex(g => g.user_id === currentUserId);
        if (currentIndex > 0) {
            openViewer(momentsData[currentIndex - 1].user_id);
        } else {
            // First user, first moment -> just restart
            currentMomentIndex = 0;
            playMoment();
        }
    }

    function nextMoment() {
        currentMomentIndex++;
        playMoment();
    }

    function prevMoment() {
        if (currentMomentIndex > 0) {
            currentMomentIndex--;
            playMoment();
        } else {
            moveToPrevUser();
        }
    }

    function showViews() {
        const userGroup = momentsData.find(g => g.user_id === currentUserId);
        if (!userGroup) return;
        const moment = userGroup.moments[currentMomentIndex];
        
        clearTimeout(progressTimer);
        const vid = document.getElementById('mvVideo');
        if (vid && !vid.paused) vid.pause();
        if (currentAudio) currentAudio.pause();

        const overlay = document.getElementById('mvViewsOverlay');
        const list = document.getElementById('mvViewsList');
        list.innerHTML = '';
        
        const viewers = moment.viewers || [];
        const reactions = moment.reactions || [];
        
        // Ensure reactors are in the viewers list
        reactions.forEach(r => {
            if (!viewers.some(v => v.id == r.user_id)) {
                viewers.push({
                    id: r.user_id,
                    username: r.username,
                    avatar: r.avatar
                });
            }
        });

        if (viewers.length > 0) {
            viewers.forEach(v => {
                // Find if this viewer had any reaction
                const reaction = reactions.find(r => r.user_id == v.id);
                const reactionHtml = reaction ? `<span class="text-sm bg-white/10 px-2.5 py-0.5 rounded-full border border-white/10 shadow-lg animate-bounce" title="Reacted ${reaction.emoji}">${reaction.emoji}</span>` : '';
                
                list.insertAdjacentHTML('beforeend', `
                    <div class="flex items-center justify-between p-2 hover:bg-white/5 rounded-xl cursor-default transition-colors">
                        <div class="flex items-center gap-3">
                            <img src="${v.avatar}" class="w-10 h-10 rounded-full border border-white/10 object-cover" />
                            <span class="text-sm font-semibold text-white/90">${v.username}</span>
                        </div>
                        ${reactionHtml}
                    </div>
                `);
            });
        } else {
            list.innerHTML = '<p class="text-center text-white/40 text-xs mt-10">No views yet.</p>';
        }

        overlay.classList.remove('hidden');
        // Trigger reflow
        void overlay.offsetWidth;
        document.getElementById('mvViewsPanel').classList.remove('translate-y-full');
    }

    function hideViews() {
        document.getElementById('mvViewsPanel').classList.add('translate-y-full');
        setTimeout(() => {
            document.getElementById('mvViewsOverlay').classList.add('hidden');
            playMoment();
        }, 300);
    }

    async function deleteCurrentMoment() {
        if (!confirm('Delete this moment?')) return;
        const userGroup = momentsData.find(g => g.user_id === currentUserId);
        if (!userGroup) return;
        const moment = userGroup.moments[currentMomentIndex];

        try {
            const res = await fetch(`/messaging/api/moments/${moment.id}/`, {
                method: 'POST', // Django view expects POST or DELETE. We used require_POST in view
                headers: {
                    'X-CSRFToken': window.SDH_DATA.csrfToken
                }
            });
            if (res.ok) {
                // Deletion handled via WebSocket event locally, but we can fast-track
                handleDeleteMomentEvent(currentUserId, moment.id);
            }
        } catch(e) {
            console.error(e);
        }
    }

    // ─── INTERACTIONS ────────────────────────────────────────────────────────

    async function sendReaction(emoji) {
        const userGroup = momentsData.find(g => g.user_id === currentUserId);
        if (!userGroup) return;
        
        // Don't send to self
        if (userGroup.username === window.SDH_DATA.currentUser) return;

        const moment = userGroup.moments[currentMomentIndex];

        // Save reaction in backend DB
        const formData = new FormData();
        formData.append('emoji', emoji);
        fetch(`/messaging/api/moments/${moment.id}/react/`, {
            method: 'POST',
            headers: {
                'X-CSRFToken': window.SDH_DATA.csrfToken
            },
            body: formData
        }).catch(e => console.error("Failed to save reaction", e));
        
        // Show floating emoji animation (premium touch)
        const floater = document.createElement('div');
        floater.innerText = emoji;
        floater.className = 'fixed bottom-20 left-1/2 text-6xl animate-float-up pointer-events-none z-[100]';
        document.body.appendChild(floater);
        setTimeout(() => floater.remove(), 1500);
        
        // Pause moment briefly
        clearTimeout(progressTimer);
        setTimeout(playMoment, 1000);
    }

    async function sendReply() {
        const input = document.getElementById('mvReplyInput');
        const text = input.value.trim();
        if (!text) return;

        const userGroup = momentsData.find(g => g.user_id === currentUserId);
        if (!userGroup) return;
        
        if (userGroup.username === window.SDH_DATA.currentUser) {
            input.value = '';
            return;
        }

        const moment = userGroup.moments[currentMomentIndex];

        await sendDirectMessage(userGroup.username, text, moment.id);
        input.value = '';
        
        // Toast
        const floater = document.createElement('div');
        floater.innerText = "Reply Sent ✓";
        floater.className = 'fixed top-20 left-1/2 -translate-x-1/2 bg-white text-black px-4 py-2 rounded-full font-bold shadow-2xl animate-float-up z-[100]';
        document.body.appendChild(floater);
        setTimeout(() => floater.remove(), 2000);
    }

    async function sendDirectMessage(username, text, momentId) {
        try {
            const payload = {
                receiver: username,
                message: text,
                message_type: 'text'
            };
            if (momentId) {
                payload.moment_id = momentId;
            }
            await fetch('/messaging/api/save/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': window.SDH_DATA.csrfToken
                },
                body: JSON.stringify(payload)
            });
        } catch (e) {
            console.error("Failed to send reaction", e);
        }
    }

    function showSoundtrackUnavailable() {
        if (window.SDH?.showComingSoon) {
            window.SDH.showComingSoon('Soundtrack integration');
        } else {
            const msg = "This feature is coming soon.";
            const floater = document.createElement('div');
            floater.innerText = msg;
            floater.className = 'fixed bottom-12 left-1/2 -translate-x-1/2 bg-divine-card border border-divine-gold/30 text-divine-gold px-6 py-3 rounded-xl shadow-2xl animate-toast z-[100] text-sm font-medium text-center max-w-sm';
            document.body.appendChild(floater);
            setTimeout(() => floater.remove(), 3000);
        }
    }

    function retryCurrentMedia() {
        const userGroup = momentsData.find(g => g.user_id === currentUserId || String(g.user_id) === String(currentUserId));
        if (!userGroup) return;
        const moment = userGroup.moments[currentMomentIndex];
        if (!moment) return;
        const errCard = document.getElementById('mvImageErrorCard');
        if (errCard) errCard.classList.add('hidden');
        if (moment.moment_type === 'image') {
            const img = document.getElementById('mvImage');
            if (img) {
                const buster = (moment.media_url.includes('?') ? '&' : '?') + 't=' + Date.now();
                img.src = moment.media_url + buster;
                img.classList.remove('hidden');
            }
        }
    }

    return {
        init,
        retryCurrentMedia,
        showUploadModal,
        toggleUploadFields,
        uploadMoment,
        openViewer,
        closeViewer,
        nextMoment,
        prevMoment,
        deleteCurrentMoment,
        sendReaction,
        sendReply,
        setSoundtrackMode,
        searchSpotify,
        clearSpotifySelection,
        updateSoundtrackFile,
        clearSoundtrackFile,
        showSoundtrackUnavailable,
        handleNewMomentEvent,     // Exposed for chat.js WS event routing
        handleDeleteMomentEvent,  // Exposed for chat.js WS event routing
        handleMomentViewedEvent,  // Exposed for chat.js WS event routing
        handleMomentReactedEvent, // Exposed for chat.js WS event routing
        showViews,
        hideViews,
        // Status Privacy APIs
        openPrivacyModal,
        handlePrivacyRadioChange,
        togglePrivacyContact,
        selectAllPrivacyContacts,
        filterPrivacyContacts,
        savePrivacySettings,
        handleMediaSelection,
        clearMediaSelection,
        updateUploadPrivacyBadge,
        getPrivacySettings: () => privacySettings,
        getSvgAvatar
    };

    // ─── STATUS PRIVACY LOGIC ───────────────────────────────────────────────

    async function loadPrivacySettings() {
        try {
            const res = await fetch('/messaging/api/moments/privacy/');
            if (!res.ok) return;
            const data = await res.json();
            if (data.status === 'ok') {
                privacySettings.privacy_type = data.privacy_type || 'all';
                privacySettings.custom_user_ids = data.custom_user_ids || [];
                privacySettings.friends = data.friends || [];
                updateUploadPrivacyBadge();
            }
        } catch (e) {
            console.error("Failed to load moment privacy settings", e);
        }
    }

    function updateUploadPrivacyBadge() {
        const type = uploadPrivacyType || privacySettings.privacy_type;
        const customIds = uploadCustomUserIds !== null ? uploadCustomUserIds : privacySettings.custom_user_ids;

        const iconEl = document.getElementById('muPrivacyIcon');
        const labelEl = document.getElementById('muPrivacyLabel');
        if (!iconEl || !labelEl) return;

        if (type === 'all') {
            iconEl.textContent = '👥';
            labelEl.textContent = 'All Contacts';
        } else if (type === 'exclude') {
            iconEl.textContent = '🚫';
            const count = customIds ? customIds.length : 0;
            labelEl.textContent = count === 0 ? 'All Contacts' : `${count} excluded`;
        } else if (type === 'only') {
            iconEl.textContent = '⭐';
            const count = customIds ? customIds.length : 0;
            labelEl.textContent = count === 0 ? 'No contacts selected' : `${count} selected`;
        }
    }

    function purgeSearchAutofill() {
        const inp = document.getElementById('mpSearchInput');
        if (!inp) return;
        const curUser = (window.SDH_DATA?.currentUser || '').toLowerCase();
        const check = () => {
            if (inp.value && (inp.value.toLowerCase() === curUser || inp.value.toLowerCase() === 'raj_123')) {
                inp.value = '';
                renderContactsList('');
            }
        };
        inp.value = '';
        requestAnimationFrame(check);
        setTimeout(check, 50);
        setTimeout(check, 150);
        setTimeout(check, 350);
    }

    async function openPrivacyModal(fromUpload = false) {
        isFromUploadModal = fromUpload;
        const modal = document.getElementById('momentPrivacyModal');
        if (!modal) return;

        if (!privacySettings.friends || privacySettings.friends.length === 0) {
            await loadPrivacySettings();
        }

        tempPrivacyType = (fromUpload && uploadPrivacyType) ? uploadPrivacyType : privacySettings.privacy_type;
        const sourceIds = (fromUpload && uploadCustomUserIds !== null) ? uploadCustomUserIds : privacySettings.custom_user_ids;
        tempSelectedUserIds = new Set(sourceIds);

        const radios = document.querySelectorAll('input[name="moment_privacy"]');
        radios.forEach(r => {
            r.checked = (r.value === tempPrivacyType);
        });

        const searchInp = document.getElementById('mpSearchInput');
        if (searchInp) {
            searchInp.value = '';
            if (!searchInp.dataset.boundPurge) {
                searchInp.dataset.boundPurge = 'true';
                searchInp.addEventListener('focus', () => purgeSearchAutofill());
                searchInp.addEventListener('input', () => {
                    const curUser = (window.SDH_DATA?.currentUser || '').toLowerCase();
                    if (searchInp.value && (searchInp.value.toLowerCase() === curUser || searchInp.value.toLowerCase() === 'raj_123')) {
                        searchInp.value = '';
                        renderContactsList('');
                    }
                });
                searchInp.addEventListener('animationstart', (e) => {
                    if (e.animationName && e.animationName.includes('onautofill')) {
                        purgeSearchAutofill();
                    }
                });
            }
        }
        purgeSearchAutofill();

        renderPrivacyContactsUI();
        modal.classList.remove('hidden');
    }

    function handlePrivacyRadioChange(newType) {
        tempPrivacyType = newType;
        const searchInp = document.getElementById('mpSearchInput');
        if (searchInp) searchInp.value = '';
        purgeSearchAutofill();
        renderPrivacyContactsUI();
    }

    function renderPrivacyContactsUI() {
        const contactsSection = document.getElementById('mpContactsSection');
        const headingEl = document.getElementById('mpSelectionHeading');
        const excludedBadge = document.getElementById('mpExcludedBadge');
        const includedBadge = document.getElementById('mpIncludedBadge');

        const count = tempSelectedUserIds.size;
        if (tempPrivacyType === 'exclude') {
            excludedBadge?.classList.remove('hidden');
            if (excludedBadge) excludedBadge.textContent = `${count} excluded`;
            includedBadge?.classList.add('hidden');
        } else if (tempPrivacyType === 'only') {
            includedBadge?.classList.remove('hidden');
            if (includedBadge) includedBadge.textContent = `${count} selected`;
            excludedBadge?.classList.add('hidden');
        } else {
            excludedBadge?.classList.add('hidden');
            includedBadge?.classList.add('hidden');
        }

        if (tempPrivacyType === 'all') {
            contactsSection?.classList.add('hidden');
            return;
        }

        contactsSection?.classList.remove('hidden');
        if (headingEl) {
            headingEl.textContent = tempPrivacyType === 'exclude' 
                ? 'Choose contacts to exclude' 
                : 'Choose contacts to share with';
        }

        renderContactsList(document.getElementById('mpSearchInput')?.value || '');
    }

    function renderContactsList(filterText = '') {
        const listEl = document.getElementById('mpContactsList');
        if (!listEl) return;

        const q = filterText.toLowerCase().trim();
        const filtered = (privacySettings.friends || []).filter(f => 
            f.username.toLowerCase().includes(q) || f.full_name.toLowerCase().includes(q)
        );

        if (filtered.length === 0) {
            listEl.innerHTML = `<div class="text-center py-6 text-xs text-divine-muted">No contacts found.</div>`;
            return;
        }

        let html = '';
        filtered.forEach(f => {
            const isChecked = tempSelectedUserIds.has(f.id);
            html += `
                <div class="mp-contact-item flex items-center justify-between p-2.5 rounded-xl hover:bg-white/5 cursor-pointer transition-colors"
                     onclick="SDH.Moments.togglePrivacyContact(${f.id})">
                    <div class="flex items-center gap-3 min-w-0">
                        <img src="${f.avatar}" class="w-9 h-9 rounded-full object-cover border border-white/10 flex-shrink-0" />
                        <div class="min-w-0">
                            <div class="mp-contact-name text-xs font-semibold text-divine-text truncate">${f.full_name}</div>
                            <div class="mp-contact-username text-[10px] text-divine-muted truncate">@${f.username}</div>
                        </div>
                    </div>
                    <input type="checkbox" ${isChecked ? 'checked' : ''} class="w-4 h-4 rounded text-divine-gold focus:ring-divine-gold border-divine-border pointer-events-none" />
                </div>
            `;
        });
        listEl.innerHTML = html;
    }

    function togglePrivacyContact(userId) {
        if (tempSelectedUserIds.has(userId)) {
            tempSelectedUserIds.delete(userId);
        } else {
            tempSelectedUserIds.add(userId);
        }
        renderPrivacyContactsUI();
    }

    function selectAllPrivacyContacts(select) {
        if (select) {
            (privacySettings.friends || []).forEach(f => tempSelectedUserIds.add(f.id));
        } else {
            tempSelectedUserIds.clear();
        }
        renderPrivacyContactsUI();
    }

    function filterPrivacyContacts(val) {
        renderContactsList(val);
    }

    async function savePrivacySettings() {
        const btn = document.getElementById('mpSaveBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerText = 'Saving...';
        }

        const selectedIds = Array.from(tempSelectedUserIds);

        try {
            const res = await fetch('/messaging/api/moments/privacy/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': window.SDH_DATA.csrfToken
                },
                body: JSON.stringify({
                    privacy_type: tempPrivacyType,
                    user_ids: selectedIds
                })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                privacySettings.privacy_type = data.privacy_type;
                privacySettings.custom_user_ids = data.custom_user_ids;
                uploadPrivacyType = data.privacy_type;
                uploadCustomUserIds = data.custom_user_ids;

                updateUploadPrivacyBadge();
                document.getElementById('momentPrivacyModal')?.classList.add('hidden');
                SDH.Chat?.showToast?.('Moment visibility updated successfully.', 'success');
            } else {
                alert(data.error || 'Failed to update visibility settings');
            }
        } catch (e) {
            console.error(e);
            alert('Failed to update visibility settings');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerText = 'Save Preferences';
            }
        }
    }
})();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        SDH.Moments.init();
    });
} else {
    SDH.Moments.init();
}

// Extra animation CSS for float-up
const style = document.createElement('style');
style.textContent = `
@keyframes floatUp {
    0% { transform: translate(-50%, 0) scale(0.5); opacity: 0; }
    20% { transform: translate(-50%, -20px) scale(1.2); opacity: 1; }
    100% { transform: translate(-50%, -100px) scale(1); opacity: 0; }
}
.animate-float-up {
    animation: floatUp 1.5s ease-out forwards;
}
@keyframes toastSlide {
    0% { transform: translate(-50%, 20px); opacity: 0; }
    10% { transform: translate(-50%, 0); opacity: 1; }
    85% { transform: translate(-50%, 0); opacity: 1; }
    100% { transform: translate(-50%, 20px); opacity: 0; }
}
.animate-toast {
    animation: toastSlide 3s ease-in-out forwards;
}
`;
document.head.appendChild(style);
