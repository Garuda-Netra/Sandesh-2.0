from django.contrib.auth.backends import ModelBackend
from django.contrib.auth.models import User
from django.db.models import Q
from .models import UserProfile
import phonenumbers

class EmailPhoneUsernameBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, **kwargs):
        if not username:
            return None
        
        # Try to parse as phone number if it looks like one
        phone_query = None
        try:
            # If the user typed a 10 digit number without +, assume India (+91)
            # or try to parse whatever they gave
            if username.isdigit() and len(username) == 10:
                parsed_phone = phonenumbers.parse(f"+91{username}")
            else:
                # Let phonenumbers try to parse it (requires + for international usually, 
                # but we'll specify 'IN' region as a default fallback)
                parsed_phone = phonenumbers.parse(username, 'IN')
            
            if phonenumbers.is_valid_number(parsed_phone):
                phone_query = phonenumbers.format_number(parsed_phone, phonenumbers.PhoneNumberFormat.E164)
        except phonenumbers.NumberParseException:
            phone_query = None

        try:
            # Construct query to match username, email, or phone number
            query = Q(username__iexact=username) | Q(email__iexact=username)
            if phone_query:
                query |= Q(profile__phone_number=phone_query)
            elif username.startswith('+'):
                # Fallback if they typed a literal +number that phonenumbers didn't like
                query |= Q(profile__phone_number=username)
                
            user = User.objects.get(query)
        except User.DoesNotExist:
            # Try getting by exact phone number string as fallback
            try:
                user = User.objects.get(profile__phone_number=username)
            except (User.DoesNotExist, User.MultipleObjectsReturned):
                return None
        except User.MultipleObjectsReturned:
            # Should not happen as username/email/phone are unique, but just in case
            user = User.objects.filter(query).first()
            
        if user and user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None
