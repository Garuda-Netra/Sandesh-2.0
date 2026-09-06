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
    let searchTimeout = null;
    const MOMENT_DURATION = 5000; // 5 seconds per image/text

    // Keep track of viewed moments in localStorage
    let viewedMomentsKey = 'sdh_viewed_moments';
    let viewedMoments = {};

    function init() {
        viewedMomentsKey = `sdh_viewed_moments_${window.SDH_DATA.currentUserId}`;
        viewedMoments = JSON.parse(localStorage.getItem(viewedMomentsKey) || '{}');
        fetchMoments();
        
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
        if (!tray || !trayContainer) return;

        tray.innerHTML = '';

        if (momentsData.length === 0) {
            trayContainer.classList.add('hidden');
            return;
        }

        trayContainer.classList.remove('hidden');

        // Sort: Users with unseen moments first, then seen, then alphabetical
        momentsData.sort((a, b) => {
            const aSeen = isAllSeenForUser(a);
            const bSeen = isAllSeenForUser(b);
            if (aSeen === bSeen) return a.username.localeCompare(b.username);
            return aSeen ? 1 : -1;
        });

        momentsData.forEach(userGroup => {
            const ringClass = isAllSeenForUser(userGroup) ? 'moment-ring-seen' : 'moment-ring';
            const avatarUrl = userGroup.moments[0].media_url || `https://ui-avatars.com/api/?name=${userGroup.username}&background=random`;
            
            const html = `
                <div class="flex flex-col items-center gap-1 cursor-pointer w-16 flex-shrink-0" onclick="SDH.Moments.openViewer(${userGroup.user_id})">
                    <div class="${ringClass} p-[2px] transition-transform hover:scale-105">
                        <img src="${avatarUrl}" class="w-12 h-12 rounded-full border-2 border-divine-surface object-cover bg-divine-surface" />
                    </div>
                    <span class="text-[10px] text-white/80 w-full truncate text-center">${userGroup.user_id == window.SDH_DATA.currentUserId ? 'You' : userGroup.username}</span>
                </div>
            `;
            tray.insertAdjacentHTML('beforeend', html);
        });
    }

    function handleNewMomentEvent(moment) {
        let userGroup = momentsData.find(g => g.user_id === moment.user_id);
        if (!userGroup) {
            userGroup = { user_id: moment.user_id, username: moment.username, moments: [] };
            momentsData.push(userGroup);
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
        clearSpotifySelection();
        setSoundtrackMode('upload');
        toggleUploadFields();
    }

    function toggleUploadFields() {
        const type = document.getElementById('muType').value;
        const mediaGroup = document.getElementById('muMediaGroup');
        const textGroup = document.getElementById('muTextGroup');
        const fileInput = document.getElementById('muFile');

        if (type === 'text') {
            mediaGroup.classList.add('hidden');
            textGroup.classList.remove('hidden');
        } else {
            mediaGroup.classList.remove('hidden');
            textGroup.classList.add('hidden');
            if (type === 'image') fileInput.accept = 'image/*';
            if (type === 'video') fileInput.accept = 'video/*';
        }
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
        currentUserId = userId;
        const userGroup = momentsData.find(g => g.user_id === userId);
        if (!userGroup) return;

        // Find first unseen
        let startIndex = userGroup.moments.findIndex(m => !isSeen(m));
        currentMomentIndex = startIndex === -1 ? 0 : startIndex;

        document.getElementById('momentsViewerModal').classList.remove('hidden');
        document.getElementById('momentsViewerModal').classList.add('flex');
        playMoment();
    }

    function closeViewer() {
        document.getElementById('momentsViewerModal').classList.add('hidden');
        document.getElementById('momentsViewerModal').classList.remove('flex');
        clearTimeout(progressTimer);
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

    function playMoment() {
        clearTimeout(progressTimer);
        const userGroup = momentsData.find(g => g.user_id === currentUserId);
        if (!userGroup || currentMomentIndex >= userGroup.moments.length) {
            // Reached end for this user, try next user
            moveToNextUser();
            return;
        }

        const moment = userGroup.moments[currentMomentIndex];

        // Update Header
        const avatarUrl = userGroup.moments[0].media_url || `https://ui-avatars.com/api/?name=${userGroup.username}&background=random`;
        document.getElementById('mvAvatar').src = avatarUrl;
        document.getElementById('mvUsername').innerText = userGroup.username;
        document.getElementById('mvTime').innerText = new Date(moment.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

        // Show/Hide Delete and Views buttons
        const isMine = userGroup.username === window.SDH_DATA.currentUser;
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
        caption.innerText = moment.caption || '';
        
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

        let audioDuration = MOMENT_DURATION;

        if (audioUrl) {
            currentAudio = new Audio(audioUrl);
            currentAudio.play().catch(e => {
                console.warn('Autoplay prevented:', e);
                // Could show a "Tap to unmute" button here
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
            
            // Limit audio to 15s to keep moments snappy
            audioDuration = 15000;
        }

        if (moment.moment_type === 'image') {
            img.src = moment.media_url;
            img.classList.remove('hidden');
            if (activeBarFill) activeBarFill.style.animationDuration = `${audioDuration}ms`;
            progressTimer = setTimeout(nextMoment, audioDuration);
        } else if (moment.moment_type === 'text') {
            txt.innerText = moment.text_content;
            txt.classList.remove('hidden');
            document.getElementById('mvMediaContainer').style.background = `linear-gradient(135deg, hsl(${Math.random()*360}, 70%, 50%), hsl(${Math.random()*360}, 70%, 30%))`;
            if (activeBarFill) activeBarFill.style.animationDuration = `${audioDuration}ms`;
            progressTimer = setTimeout(nextMoment, audioDuration);
        } else if (moment.moment_type === 'video') {
            // Mute video if we have a soundtrack overriding it
            vid.muted = !!audioUrl; 
            
            // Set up handlers before setting src to avoid race conditions
            vid.onloadedmetadata = () => {
                let duration = (vid.duration * 1000) || MOMENT_DURATION;
                if (audioUrl) duration = audioDuration; // Audio duration takes precedence
                if (activeBarFill) activeBarFill.style.animationDuration = `${duration}ms`;
                clearTimeout(progressTimer);
                progressTimer = setTimeout(nextMoment, duration);
            };

            vid.onended = () => {
                // If there's no custom soundtrack overriding, go to next moment immediately
                if (!audioUrl) {
                    clearTimeout(progressTimer);
                    nextMoment();
                }
            };

            vid.onerror = () => {
                console.error("Video failed to load, skipping to next moment.");
                clearTimeout(progressTimer);
                progressTimer = setTimeout(nextMoment, MOMENT_DURATION);
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
        const msg = "Soundtrack integrations are currently undergoing enhancements. We appreciate your patience as we prepare to bring you a superior audio experience soon.";
        const floater = document.createElement('div');
        floater.innerText = msg;
        floater.className = 'fixed bottom-12 left-1/2 -translate-x-1/2 bg-divine-card border border-divine-gold/30 text-divine-gold px-6 py-3 rounded-xl shadow-2xl animate-toast z-[100] text-sm font-medium text-center max-w-sm';
        document.body.appendChild(floater);
        setTimeout(() => floater.remove(), 3000);
    }

    return {
        init,
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
        hideViews
    };
})();

document.addEventListener('DOMContentLoaded', () => {
    SDH.Moments.init();
});

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
