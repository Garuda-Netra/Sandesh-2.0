"""
Users Views

Landing page, Registration, Login, Logout, Profile management.
Friend requests, blocking, unblocking.
"""

import json
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth import login, logout, alogout
from django.contrib.auth.models import User
from django.contrib.auth.decorators import login_required
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_POST, require_GET
from django.http import JsonResponse
from django.contrib import messages
from django.urls import reverse
from django.utils import timezone
from django.db.models import Q
from django.conf import settings
from asgiref.sync import sync_to_async

from .forms import SDHRegistrationForm, SDHLoginForm, ProfileUpdateForm
from .models import UserProfile, FriendRequest, Friendship


# ---------------------------------------------------------------------------
# Landing Page
# ---------------------------------------------------------------------------
def index(request):
    """
    Public landing page with OM particle animation.
    Redirects authenticated users directly to chat.
    """
    if request.user.is_authenticated:
        return redirect('messaging:chat')
    return render(request, 'index.html')


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------
@csrf_protect
def register_view(request):
    if request.user.is_authenticated:
        return redirect('messaging:chat')
        
    if request.method == 'POST':
        form = SDHRegistrationForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user, backend='users.backends.EmailPhoneUsernameBackend')
            return redirect('messaging:chat')
    else:
        form = SDHRegistrationForm()
        
    return render(request, 'register.html', {'form': form})


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------
@csrf_protect
def login_view(request):
    if request.user.is_authenticated:
        return redirect('messaging:chat')
        
    if request.method == 'POST':
        form = SDHLoginForm(request, data=request.POST)
        if form.is_valid():
            user = form.get_user()
            login(request, user)
            return redirect('messaging:chat')
    else:
        form = SDHLoginForm()
        
    return render(request, 'login.html', {'form': form})


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Clerk Authentication API
# ---------------------------------------------------------------------------
@csrf_protect
@require_POST
def clerk_login_view(request):
    """
    Endpoint for Clerk token verification and user login/registration.
    Accepts: POST {"token": "<token>"}
    Returns: redirect to chat on success, redirect to login on error.
    """
    try:
        # ── 0. Extract token from request ───────────────────────────
        if request.content_type == 'application/json':
            body = json.loads(request.body)
            token = body.get('token')
        else:
            token = request.POST.get('token')

        if not token:
            raise ValueError('token is required')

        print(f"[Clerk Auth] Token received (length={len(token)})")

        clerk_secret = getattr(settings, 'CLERK_SECRET_KEY', None)
        if not clerk_secret:
            raise ValueError('Server is missing Clerk Secret Key')

        import jwt
        from jwt import PyJWKClient
        import requests as http_requests

        # ── 1. Decode token WITHOUT verification to read claims ─────
        unverified_claims = jwt.decode(
            token,
            options={
                "verify_signature": False,
                "verify_exp": False,
                "verify_nbf": False,
                "verify_iat": False,
                "verify_aud": False,
            }
        )
        issuer = unverified_claims.get("iss")
        if not issuer:
            raise ValueError('Token missing issuer (iss)')

        clerk_user_id = unverified_claims.get("sub")
        print(f"[Clerk Auth] Issuer={issuer}, sub={clerk_user_id}")

        # ── 2. Verify token signature with JWKS ────────────────────
        jwks_url = f"{issuer.rstrip('/')}/.well-known/jwks.json"
        print(f"[Clerk Auth] Fetching JWKS from {jwks_url}")
        jwks_client = PyJWKClient(jwks_url)
        signing_key = jwks_client.get_signing_key_from_jwt(token)

        header = jwt.get_unverified_header(token)
        alg = header.get('alg', 'RS256')
        print(f"[Clerk Auth] Token algorithm: {alg}")

        decoded_token = jwt.decode(
            token,
            signing_key.key,
            algorithms=[alg],
            options={"verify_aud": False},
            leeway=120,  # Allow 120 seconds for clock skew
        )
        print(f"[Clerk Auth] Token verified successfully. sub={decoded_token.get('sub')}")

        clerk_user_id = decoded_token.get("sub")
        if not clerk_user_id:
            raise ValueError('Token missing subject (sub)')

        # ── 3. Fetch user details from Clerk API ───────────────────
        api_headers = {
            "Authorization": f"Bearer {clerk_secret}",
            "Content-Type": "application/json",
        }
        api_url = f"https://api.clerk.com/v1/users/{clerk_user_id}"
        print(f"[Clerk Auth] Fetching user from Clerk API: {api_url}")
        resp = http_requests.get(api_url, headers=api_headers, timeout=10)
        print(f"[Clerk Auth] Clerk API response: {resp.status_code}")

        if resp.status_code != 200:
            print(f"[Clerk Auth] Clerk API error body: {resp.text[:500]}")
            raise ValueError(f'Failed to fetch user details from Clerk (HTTP {resp.status_code})')

        user_data = resp.json()

        # ── 4. Extract primary email ───────────────────────────────
        email = None
        primary_email_id = user_data.get('primary_email_address_id')
        for e in user_data.get('email_addresses', []):
            if e['id'] == primary_email_id:
                email = e['email_address']
                break

        if not email and user_data.get('email_addresses'):
            email = user_data['email_addresses'][0]['email_address']

        if not email:
            raise ValueError('Clerk account does not have an email.')

        print(f"[Clerk Auth] Email resolved: {email}")

        # ── 5. Find or create Django user ──────────────────────────
        user = User.objects.filter(email=email).first()

        if not user:
            base_username = email.split('@')[0]
            final_username = base_username
            counter = 1
            while User.objects.filter(username=final_username).exists():
                final_username = f"{base_username}{counter}"
                counter += 1

            user = User.objects.create(username=final_username, email=email)
            user.set_unusable_password()
            user.save()
            print(f"[Clerk Auth] Created new user: {final_username}")
        else:
            print(f"[Clerk Auth] Found existing user: {user.username}")

        # Update profile if needed
        profile, _ = UserProfile.objects.get_or_create(user=user)

        if not profile.is_active_account:
            raise ValueError('Account deleted.')

        # ── 6. Log in the user ─────────────────────────────────────
        login(request, user, backend='django.contrib.auth.backends.ModelBackend')
        print(f"[Clerk Auth] Login successful for {user.username}, redirecting to chat.")

        # If the request came from our HTML form POST, redirect naturally.
        if request.content_type != 'application/json':
            return redirect('messaging:chat')

        return JsonResponse({
            'status': 'success',
            'redirect_url': reverse('messaging:chat'),
        })

    except Exception as e:
        import traceback
        print(f"[Clerk Auth] ERROR: {e}")
        traceback.print_exc()

        if request.content_type != 'application/json':
            messages.error(request, f"Google sign-in failed: {e}")
            return redirect('users:login')

        return JsonResponse({'status': 'error', 'error': str(e)}, status=400)




# ---------------------------------------------------------------------------
# Logout  (sync — avoids SynchronousOnlyOperation from ORM/session access)
# ---------------------------------------------------------------------------
def logout_view(request):
    if request.user.is_authenticated:
        # Mark offline
        try:
            _mark_offline(request.user)
        except Exception:
            pass
    logout(request)
    return redirect('users:index')


def _mark_offline(user):
    """Sync helper: mark user offline in DB and stamp last_seen."""
    try:
        profile = user.profile
        profile.is_online = False
        profile.last_seen = timezone.now()
        profile.save(update_fields=['is_online', 'last_seen'])
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_hidden_user_ids(user):
    """Return User IDs that should be hidden from `user`'s contact list.

    Only checks hidden_users (cosmetic removal).
    Blocked users are NOT hidden — they remain visible in the chat list
    (WhatsApp-style blocking).
    """
    try:
        profile = user.profile
    except Exception:
        return []

    user_ids = set()
    try:
        user_ids.update(profile.hidden_users.values_list('user_id', flat=True))
    except Exception:
        pass
    return list(user_ids)


def _get_blocked_user_ids(user):
    """Return User IDs blocked by this user."""
    try:
        profile = user.profile
    except Exception:
        return []
    try:
        return list(profile.blocked_users.values_list('user_id', flat=True))
    except Exception:
        return []


def _get_friend_user_ids(user):
    """Return User IDs that are friends with this user."""
    try:
        profile = user.profile
        friend_profile_ids = Friendship.get_friend_profile_ids(profile)
        if not friend_profile_ids:
            return []
        return list(
            UserProfile.objects.filter(id__in=friend_profile_ids)
            .values_list('user_id', flat=True)
        )
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Remove User from My List
# ---------------------------------------------------------------------------

@login_required
@require_POST
@csrf_protect
def remove_user_view(request):
    """
    POST /users/api/remove-user/

    Body: { "target_user_id": <int>, "block": bool }

    When block=false: adds target to hidden_users (cosmetic removal).
    When block=true: adds target to blocked_users ONLY (user stays visible
    in chat list but messaging is disabled — WhatsApp-style).
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    target_user_id = body.get('target_user_id')
    if not target_user_id:
        return JsonResponse({'error': 'target_user_id is required'}, status=400)

    target_user = get_object_or_404(User, id=target_user_id)

    # Never allow hiding yourself
    if target_user.id == request.user.id:
        return JsonResponse({'error': 'Cannot remove yourself'}, status=400)

    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Your profile was not found'}, status=404)

    try:
        target_profile = target_user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Target profile not found'}, status=404)

    should_block = bool(body.get('block'))

    if should_block:
        # WhatsApp-style: block only — do NOT hide from chat list
        my_profile.blocked_users.add(target_profile)
        
        from channels.layers import get_channel_layer
        from asgiref.sync import async_to_sync
        channel_layer = get_channel_layer()
        event_data = {
            'type': 'user_blocked',
            'blocker_id': request.user.id,
            'blocker_username': request.user.username,
            'blocked_id': target_user.id,
            'blocked_username': target_user.username,
        }
        async_to_sync(channel_layer.group_send)(f'user_chat_{request.user.id}', event_data)
        async_to_sync(channel_layer.group_send)(f'user_chat_{target_user.id}', event_data)

        return JsonResponse({
            'status': 'blocked',
            'removed_user_id': target_user.id,
        })
    else:
        # Cosmetic removal: hide from sidebar
        my_profile.hidden_users.add(target_profile)
        return JsonResponse({
            'status': 'removed',
            'removed_user_id': target_user.id,
        })


# ---------------------------------------------------------------------------
# Unblock User
# ---------------------------------------------------------------------------
@login_required
@require_POST
@csrf_protect
def unblock_user_view(request):
    """
    POST /users/api/unblock-user/

    Body: { "target_user_id": <int> }

    Removes the target from blocked_users.
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    target_user_id = body.get('target_user_id')
    if not target_user_id:
        return JsonResponse({'error': 'target_user_id is required'}, status=400)

    target_user = get_object_or_404(User, id=target_user_id)

    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Your profile was not found'}, status=404)

    try:
        target_profile = target_user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Target profile not found'}, status=404)

    my_profile.blocked_users.remove(target_profile)

    from channels.layers import get_channel_layer
    from asgiref.sync import async_to_sync
    channel_layer = get_channel_layer()
    event_data = {
        'type': 'user_unblocked',
        'unblocker_id': request.user.id,
        'unblocker_username': request.user.username,
        'unblocked_id': target_user.id,
        'unblocked_username': target_user.username,
    }
    async_to_sync(channel_layer.group_send)(f'user_chat_{request.user.id}', event_data)
    async_to_sync(channel_layer.group_send)(f'user_chat_{target_user.id}', event_data)

    return JsonResponse({
        'status': 'unblocked',
        'target_user_id': target_user.id,
    })


# ---------------------------------------------------------------------------
# Unfriend User
# ---------------------------------------------------------------------------
@login_required
@require_POST
@csrf_protect
def unfriend_view(request):
    """
    POST /users/api/unfriend/

    Body: { "target_user_id": <int> }

    Deletes the Friendship record between the current user and the target.
    Also resets any accepted FriendRequest rows so users can re-add each
    other later.  The user is then hidden from the sidebar (treated as a
    hidden contact) unless they are also blocked.
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    target_user_id = body.get('target_user_id')
    if not target_user_id:
        return JsonResponse({'error': 'target_user_id is required'}, status=400)

    if int(target_user_id) == request.user.id:
        return JsonResponse({'error': 'Cannot unfriend yourself'}, status=400)

    target_user = get_object_or_404(User, id=target_user_id)

    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Your profile was not found'}, status=404)

    try:
        target_profile = target_user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Target profile not found'}, status=404)

    # Delete the Friendship row (ordered so user1.id < user2.id)
    lo_id, hi_id = sorted([my_profile.id, target_profile.id])
    deleted_count, _ = Friendship.objects.filter(
        user1_id=lo_id, user2_id=hi_id
    ).delete()

    if deleted_count == 0:
        return JsonResponse({'error': 'You are not friends with this user.'}, status=400)

    # Reset accepted friend-request rows so they can reconnect later
    FriendRequest.objects.filter(
        from_user__in=[my_profile, target_profile],
        to_user__in=[my_profile, target_profile],
        status=FriendRequest.STATUS_ACCEPTED,
    ).update(status=FriendRequest.STATUS_REJECTED)

    # Cosmetically hide the ex-friend from the sidebar for both sides
    my_profile.hidden_users.add(target_profile)
    target_profile.hidden_users.add(my_profile)

    return JsonResponse({
        'status': 'unfriended',
        'target_user_id': target_user.id,
    })


# ---------------------------------------------------------------------------
# User List API (for sidebar) — friends + blocked contacts only
# ---------------------------------------------------------------------------
@login_required
@require_GET
def user_list(request):
    """Returns list of friends + blocked contacts for the sidebar."""
    hidden_ids = _get_hidden_user_ids(request.user)
    friend_ids = _get_friend_user_ids(request.user)
    blocked_ids = _get_blocked_user_ids(request.user)

    # Show friends + people I blocked (they remain visible per WhatsApp style)
    visible_ids = set(friend_ids) | set(blocked_ids)
    # Remove hidden users
    visible_ids -= set(hidden_ids)
    # Remove self
    visible_ids.discard(request.user.id)

    users = (
        User.objects
        .filter(id__in=visible_ids)
        .filter(profile__is_active_account=True)
        .select_related('profile')
    )
    from messaging.views import _is_chat_blocked
    data = []
    blocked_set = set(blocked_ids)
    for u in users:
        is_blocked, _ = _is_chat_blocked(request.user, u)
        try:
            is_online = u.profile.is_online if not is_blocked else False
        except UserProfile.DoesNotExist:
            is_online = False
        data.append({
            'username': u.username,
            'display_name': u.get_full_name() or u.username,
            'is_online': is_online,
            'is_blocked': u.id in blocked_set,
        })
    return JsonResponse({'users': data})


# ---------------------------------------------------------------------------
# User Search API
# ---------------------------------------------------------------------------
@login_required
@require_GET
def search_users(request):
    """
    Live user search endpoint consumed by userSearch.js.

    GET /users/api/search-users/?q=<query>

    Returns up to 30 matching users (username icontains match),
    ordered by username, excluding the current user.
    Each result includes a friendship_status field:
      'friend', 'pending_sent', 'pending_received', 'blocked', or 'none'.
    Empty query returns friends only (same behaviour as the sidebar).
    """
    q = request.GET.get('q', '').strip()

    hidden_ids = _get_hidden_user_ids(request.user)

    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        my_profile = UserProfile.objects.create(user=request.user)

    if q:
        # When searching: return ALL active users matching the query
        # (so non-friends can be discovered)
        qs = (
            User.objects
            .exclude(id=request.user.id)
            .filter(profile__is_active_account=True)
            .filter(username__icontains=q)
            .select_related('profile')
            .order_by('username')[:30]
        )
    else:
        # No query: return friends + blocked only (sidebar behaviour)
        friend_ids = _get_friend_user_ids(request.user)
        blocked_ids = _get_blocked_user_ids(request.user)
        visible_ids = set(friend_ids) | set(blocked_ids)
        visible_ids -= set(hidden_ids)
        visible_ids.discard(request.user.id)
        qs = (
            User.objects
            .filter(id__in=visible_ids)
            .filter(profile__is_active_account=True)
            .select_related('profile')
            .order_by('username')[:30]
        )

    # Pre-compute friendship data for the result set
    friend_profile_ids = Friendship.get_friend_profile_ids(my_profile)
    blocked_profile_ids = set(
        my_profile.blocked_users.values_list('id', flat=True)
    )
    sent_pending = set(
        FriendRequest.objects
        .filter(from_user=my_profile, status=FriendRequest.STATUS_PENDING)
        .values_list('to_user__user_id', flat=True)
    )
    received_pending = set(
        FriendRequest.objects
        .filter(to_user=my_profile, status=FriendRequest.STATUS_PENDING)
        .values_list('from_user__user_id', flat=True)
    )

    # Convert friend_profile_ids to user_ids for comparison
    friend_user_ids = set(
        UserProfile.objects.filter(id__in=friend_profile_ids)
        .values_list('user_id', flat=True)
    ) if friend_profile_ids else set()
    blocked_user_ids = set(
        UserProfile.objects.filter(id__in=blocked_profile_ids)
        .values_list('user_id', flat=True)
    ) if blocked_profile_ids else set()

    from messaging.views import _is_chat_blocked

    data = []
    for u in qs:
        is_blocked, _ = _is_chat_blocked(request.user, u)
        try:
            profile    = u.profile
            is_online  = profile.is_online if not is_blocked else False
            avatar_url = profile.avatar.url if profile.avatar and not is_blocked else None
            last_seen  = (
                profile.last_seen.strftime('%b ') + str(profile.last_seen.day)
                if (not is_online and profile.last_seen and not is_blocked)
                else None
            )
        except Exception:
            is_online  = False
            avatar_url = None
            last_seen  = None

        # Determine friendship status
        if u.id in blocked_user_ids:
            friendship_status = 'blocked'
        elif u.id in friend_user_ids:
            friendship_status = 'friend'
        elif u.id in sent_pending:
            friendship_status = 'pending_sent'
        elif u.id in received_pending:
            friendship_status = 'pending_received'
        else:
            friendship_status = 'none'

        if friendship_status != 'friend':
            is_online = False
            last_seen = None

        data.append({
            'id':                u.id,
            'username':          u.username,
            'is_online':         is_online,
            'avatar_url':        avatar_url,
            'last_seen':         last_seen,
            'friendship_status': friendship_status,
        })

    return JsonResponse({'users': data})


# ---------------------------------------------------------------------------
# Friend Request APIs
# ---------------------------------------------------------------------------
@login_required
@require_POST
@csrf_protect
def send_friend_request_view(request):
    """
    POST /users/api/send-friend-request/

    Body: { "target_user_id": <int> }
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    target_user_id = body.get('target_user_id')
    if not target_user_id:
        return JsonResponse({'error': 'target_user_id is required'}, status=400)

    target_user = get_object_or_404(User, id=target_user_id)

    if target_user.id == request.user.id:
        return JsonResponse({'error': 'Cannot send request to yourself'}, status=400)

    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Your profile was not found'}, status=404)

    try:
        target_profile = target_user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Target profile not found'}, status=404)

    # Check if already friends
    if Friendship.are_friends(my_profile, target_profile):
        return JsonResponse({'error': 'Already friends'}, status=400)

    # Check if a pending request already exists in either direction
    existing = FriendRequest.objects.filter(
        Q(from_user=my_profile, to_user=target_profile) |
        Q(from_user=target_profile, to_user=my_profile),
        status=FriendRequest.STATUS_PENDING,
    ).first()
    if existing:
        if existing.from_user == my_profile:
            return JsonResponse({'error': 'Request already sent'}, status=400)
        else:
            # They already sent us a request — auto-accept
            existing.status = FriendRequest.STATUS_ACCEPTED
            existing.save(update_fields=['status', 'updated_at'])
            Friendship.add_friendship(my_profile, target_profile)
            my_profile.hidden_users.remove(target_profile)
            target_profile.hidden_users.remove(my_profile)
            return JsonResponse({'status': 'accepted',
                                 'message': 'They already sent you a request — now friends!'})

    # Create new request (or update a previously rejected one)
    fr, created = FriendRequest.objects.update_or_create(
        from_user=my_profile,
        to_user=target_profile,
        defaults={'status': FriendRequest.STATUS_PENDING},
    )

    if created or fr.status == FriendRequest.STATUS_PENDING:
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f"user_chat_{target_profile.user.id}",
            {
                "type": "friend_request",
                "sender": my_profile.user.username,
            }
        )

    return JsonResponse({'status': 'sent'})


@login_required
@require_POST
@csrf_protect
def respond_friend_request_view(request):
    """
    POST /users/api/respond-friend-request/

    Body: { "request_id": <int>, "action": "accept" | "reject" }
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    request_id = body.get('request_id')
    action = body.get('action')

    if not request_id or action not in ('accept', 'reject'):
        return JsonResponse({'error': 'request_id and action (accept/reject) required'}, status=400)

    fr = get_object_or_404(FriendRequest, id=request_id)

    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Profile not found'}, status=404)

    # Only the recipient can respond
    if fr.to_user != my_profile:
        return JsonResponse({'error': 'Not authorized'}, status=403)

    if fr.status != FriendRequest.STATUS_PENDING:
        return JsonResponse({'error': 'Request already handled'}, status=400)

    if action == 'accept':
        fr.status = FriendRequest.STATUS_ACCEPTED
        fr.save(update_fields=['status', 'updated_at'])
        Friendship.add_friendship(fr.from_user, fr.to_user)
        fr.from_user.hidden_users.remove(fr.to_user)
        fr.to_user.hidden_users.remove(fr.from_user)

        # Notify the sender so their sidebar updates in real-time
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f"user_chat_{fr.from_user.user.id}",
            {
                "type": "friend_request_accepted",
                "new_friend": fr.to_user.user.username,
            }
        )

        return JsonResponse({'status': 'accepted'})
    else:
        fr.status = FriendRequest.STATUS_REJECTED
        fr.save(update_fields=['status', 'updated_at'])

        # Notify the sender so their UI updates
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f"user_chat_{fr.from_user.user.id}",
            {
                "type": "friend_request_rejected",
                "rejected_by": fr.to_user.user.username,
            }
        )

        return JsonResponse({'status': 'rejected'})


@login_required
@require_GET
def friend_requests_view(request):
    """
    GET /users/api/friend-requests/

    Returns pending incoming and outgoing friend requests.
    """
    try:
        my_profile = request.user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'incoming': [], 'outgoing': []})

    incoming = list(
        FriendRequest.objects
        .filter(to_user=my_profile, status=FriendRequest.STATUS_PENDING)
        .select_related('from_user__user')
        .order_by('-created_at')
        .values_list('id', 'from_user__user__id', 'from_user__user__username', 'created_at')
    )
    outgoing = list(
        FriendRequest.objects
        .filter(from_user=my_profile, status=FriendRequest.STATUS_PENDING)
        .select_related('to_user__user')
        .order_by('-created_at')
        .values_list('id', 'to_user__user__id', 'to_user__user__username', 'created_at')
    )

    return JsonResponse({
        'incoming': [
            {'id': r[0], 'user_id': r[1], 'username': r[2],
             'created_at': r[3].isoformat() if r[3] else None}
            for r in incoming
        ],
        'outgoing': [
            {'id': r[0], 'user_id': r[1], 'username': r[2],
             'created_at': r[3].isoformat() if r[3] else None}
            for r in outgoing
        ],
    })


# ---------------------------------------------------------------------------
# Profile Page
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Account Deletion
# ---------------------------------------------------------------------------
@login_required
@csrf_protect
async def delete_account_view(request):
    """
    POST /account/delete/

    Hard-deletes the authenticated user's account and all associated data.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    user = request.user
    
    # 1. Get all active sessions for this user to force logout via WebSockets
    from asgiref.sync import sync_to_async
    from channels.layers import get_channel_layer
    from users.models import UserSession
    
    @sync_to_async
    def get_user_session_keys(user):
        return list(UserSession.objects.filter(user=user).values_list('session_key', flat=True))
        
    session_keys = await get_user_session_keys(user)
    
    # Notify active WebSocket connections to force logout
    channel_layer = get_channel_layer()
    for key in session_keys:
        await channel_layer.group_send(
            f"session_{key}",
            {
                "type": "force_logout"
            }
        )

    # 2. Perform the hard delete synchronously
    await sync_to_async(_hard_delete_account)(user, session_keys)

    # 3. Log out the current request (clears current session cookie)
    from django.contrib.auth import alogout
    await alogout(request)

    return JsonResponse({'status': 'deleted'}, status=200)

def _hard_delete_account(user, session_keys):
    """Sync helper: perform the hard delete."""
    from django.contrib.sessions.models import Session
    from messaging.models import GroupMessage

    # 1. Delete all global sessions matching this user's UserSession records
    if session_keys:
        Session.objects.filter(session_key__in=session_keys).delete()

    # 2. Delete all group messages sent by the user (since they default to SET_NULL)
    GroupMessage.objects.filter(sender=user).delete()

    # 3. Delete the User record
    # This automatically cascades to UserProfile, Friendship, FriendRequest,
    # Message, CallLog, Moment, UserSession, GroupMembership, etc.
    user.delete()


# ---------------------------------------------------------------------------
# Profile Page
# ---------------------------------------------------------------------------
@login_required
def profile_view(request):
    profile, _ = UserProfile.objects.get_or_create(user=request.user)
    form = ProfileUpdateForm(instance=profile)

    if request.method == 'POST':
        form = ProfileUpdateForm(request.POST, request.FILES, instance=profile)
        if form.is_valid():
            form.save()
            messages.success(request, 'Profile updated successfully.')
            return redirect('users:profile')

    return render(request, 'users/profile.html', {'form': form, 'profile': profile})


# ---------------------------------------------------------------------------
# API: Fetch Target User Profile and Bio
# ---------------------------------------------------------------------------
@login_required
@require_POST
@csrf_protect
def remove_avatar_view(request):
    try:
        profile = request.user.profile
        if profile.avatar:
            profile.avatar.delete(save=True)
        return JsonResponse({'status': 'ok'})
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=400)

from django.core.mail import EmailMessage
from django.core.cache import cache

@login_required
@require_POST
@csrf_protect
def report_bug_view(request):
    user_id = request.user.id
    cache_key = f'bug_report_count_{user_id}'
    report_count = cache.get(cache_key, 0)

    if report_count >= 3:
        return JsonResponse({'error': 'Rate limit exceeded. Try again in an hour.'}, status=429)

    description = request.POST.get('description', '').strip()
    if not description:
        return JsonResponse({'error': 'Description is required'}, status=400)

    images = request.FILES.getlist('images')
    if len(images) > 5:
        return JsonResponse({'error': 'Maximum 5 images allowed'}, status=400)

    email = EmailMessage(
        subject=f'Bug Report from {request.user.username}',
        body=description,
        from_email=None,
        to=['rajkuma4rr2005@gmail.com'],
    )

    for img in images:
        if not img.name.lower().endswith(('.jpg', '.jpeg')):
            return JsonResponse({'error': 'Only JPEG images are allowed'}, status=400)
        email.attach(img.name, img.read(), img.content_type)

    try:
        email.send(fail_silently=False)
        cache.set(cache_key, report_count + 1, timeout=3600)
        return JsonResponse({'status': 'ok'})
    except Exception as e:
        # Fallback for development if email is not configured properly but we still want to simulate success
        import traceback
        traceback.print_exc()
        return JsonResponse({'error': f'Failed to send report: {str(e)}'}, status=500)

# ---------------------------------------------------------------------------
# API: Fetch Target User Profile and Bio
# ---------------------------------------------------------------------------
@login_required
@require_GET
def user_profile_api(request, username):
    """
    GET /users/api/profile/<str:username>/

    Secure API endpoint that returns the profile details and bio of target user
    IF confirmed friends with the requester, or if viewing their own profile.
    """
    target_user = get_object_or_404(User, username=username)

    try:
        my_profile = request.user.profile
        target_profile = target_user.profile
    except UserProfile.DoesNotExist:
        return JsonResponse({'error': 'Profile not found'}, status=404)

    # Check friendship status unless they are viewing themselves
    if target_user != request.user:
        if not Friendship.are_friends(my_profile, target_profile):
            return JsonResponse({'error': 'You can only view profile details of accepted friends.'}, status=403)

    from messaging.views import _is_chat_blocked
    is_blocked, _ = _is_chat_blocked(request.user, target_user) if target_user != request.user else (False, '')

    if is_blocked:
        return JsonResponse({
            'username': target_user.username,
            'display_name': target_profile.display_name,
            'bio': '',
            'phone_number': '',
            'email': '',
            'avatar_url': None,
            'is_online': False,
            'last_seen': None,
            'date_joined': None,
        })

    avatar_url = target_profile.avatar.url if target_profile.avatar else None

    return JsonResponse({
        'username': target_user.username,
        'display_name': target_profile.display_name,
        'bio': target_profile.bio,
        'phone_number': target_profile.phone_number,
        'email': target_user.email,
        'avatar_url': avatar_url,
        'is_online': target_profile.is_online,
        'last_seen': target_profile.last_seen.isoformat() if target_profile.last_seen else None,
        'date_joined': target_user.date_joined.strftime('%B %Y') if target_user.date_joined else None,
    })

# ---------------------------------------------------------------------------
# Session Management APIs
# ---------------------------------------------------------------------------
from django.contrib.sessions.models import Session
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from django.views.decorators.http import require_http_methods
from .models import UserSession

@login_required
@require_http_methods(['GET'])
def session_list_api(request):
    """Returns all active sessions for the current user."""
    sessions = UserSession.objects.filter(user=request.user).order_by('-last_activity')
    data = []
    current_session_key = request.session.session_key
    
    for s in sessions:
        if not Session.objects.filter(session_key=s.session_key).exists():
            s.delete()
            continue

        data.append({
            'session_key': s.session_key,
            'device_name': s.device_name,
            'os': s.os,
            'browser': s.browser,
            'ip_address': s.ip_address,
            'location': s.location,
            'last_activity': s.last_activity.isoformat() if s.last_activity else None,
            'is_current': s.session_key == current_session_key
        })

    return JsonResponse({'sessions': data})

@login_required
@require_http_methods(['POST'])
def terminate_session_api(request, session_key):
    """Terminates a specific session."""
    if session_key == request.session.session_key:
        return JsonResponse({'error': 'Cannot terminate current session via this endpoint'}, status=400)

    try:
        user_session = UserSession.objects.get(session_key=session_key, user=request.user)
        Session.objects.filter(session_key=session_key).delete()
        user_session.delete()

        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f"session_{session_key}",
            {
                "type": "force_logout"
            }
        )
        return JsonResponse({'success': True})
    except UserSession.DoesNotExist:
        return JsonResponse({'error': 'Session not found'}, status=404)

@login_required
@require_http_methods(['POST'])
def terminate_other_sessions_api(request):
    """Terminates all sessions except the current one."""
    current_session_key = request.session.session_key
    other_sessions = UserSession.objects.filter(user=request.user).exclude(session_key=current_session_key)
    
    channel_layer = get_channel_layer()
    for s in other_sessions:
        Session.objects.filter(session_key=s.session_key).delete()
        async_to_sync(channel_layer.group_send)(
            f"session_{s.session_key}",
            {
                "type": "force_logout"
            }
        )
        s.delete()

    return JsonResponse({'success': True})

