"""
Users Forms

Handles user registration and profile update.
Validates unique username/email, strong password.
"""

from django import forms
from django.contrib.auth.models import User
from django.contrib.auth.forms import UserCreationForm, AuthenticationForm
from .models import UserProfile


class SDHRegistrationForm(UserCreationForm):
    """
    Extended registration form requiring email.
    Includes custom styling hooks for Tailwind CSS.
    """
    email = forms.EmailField(
        required=True,
        widget=forms.EmailInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'your@email.com',
            'autocomplete': 'email',
        })
    )

    phone_number = forms.CharField(
        required=False,
        widget=forms.TextInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'Optional phone number (e.g. 9876543210)',
            'autocomplete': 'tel',
        })
    )

    username = forms.CharField(
        max_length=150,
        widget=forms.TextInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'Choose a username',
            'autocomplete': 'username',
        })
    )

    password1 = forms.CharField(
        label='Password',
        widget=forms.PasswordInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'Create a strong password',
            'autocomplete': 'new-password',
        })
    )

    password2 = forms.CharField(
        label='Confirm Password',
        widget=forms.PasswordInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'Repeat your password',
            'autocomplete': 'new-password',
        })
    )

    class Meta:
        model = User
        fields = ('username', 'email', 'password1', 'password2')

    def clean_email(self):
        email = self.cleaned_data.get('email', '').strip().lower()
        if User.objects.filter(email__iexact=email).exists():
            raise forms.ValidationError('An account with this email already exists.')
        return email

    def clean_username(self):
        username = self.cleaned_data.get('username', '').strip()
        if User.objects.filter(username__iexact=username).exists():
            raise forms.ValidationError('This username is already taken.')
        return username

    def clean_phone_number(self):
        import phonenumbers
        phone = self.cleaned_data.get('phone_number', '').strip()
        if not phone:
            return None
        
        try:
            if phone.isdigit() and len(phone) == 10:
                parsed = phonenumbers.parse(f"+91{phone}")
            else:
                parsed = phonenumbers.parse(phone, 'IN')
                
            if not phonenumbers.is_valid_number(parsed):
                raise forms.ValidationError("Invalid phone number format.")
                
            formatted = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
            if UserProfile.objects.filter(phone_number=formatted).exists():
                raise forms.ValidationError("This phone number is already registered.")
            return formatted
        except phonenumbers.NumberParseException:
            raise forms.ValidationError("Invalid phone number. Include country code if outside India.")

    def save(self, commit=True):
        user = super().save(commit=False)
        user.email = self.cleaned_data['email']
        if commit:
            user.save()
            # The signal creates the profile. Update it with the phone number.
            phone = self.cleaned_data.get('phone_number')
            if phone:
                profile = user.profile
                profile.phone_number = phone
                profile.save()
        return user


class SDHLoginForm(AuthenticationForm):
    """
    Custom login form with Tailwind-compatible widget attrs.
    """
    username = forms.CharField(
        widget=forms.TextInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'Username, Email, or Phone',
            'autocomplete': 'username',
            'autofocus': True,
        })
    )

    password = forms.CharField(
        widget=forms.PasswordInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'Password',
            'autocomplete': 'current-password',
        })
    )


class ProfileUpdateForm(forms.ModelForm):
    """
    Comprehensive, durable profile update form.
    Handles:
    - UserProfile bio
    - UserProfile phone_number (optional, validated & formatted with country code)
    - User first_name and last_name (optional)
    - Avatar file upload (validated for image types, size <= 5MB, malicious payloads)
    - Durable persistence to Cloudinary with automatic deletion of previous avatars.
    """
    first_name = forms.CharField(
        max_length=150,
        required=False,
        widget=forms.TextInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'First name',
            'autocomplete': 'given-name',
        })
    )

    last_name = forms.CharField(
        max_length=150,
        required=False,
        widget=forms.TextInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'Last name',
            'autocomplete': 'family-name',
        })
    )

    phone_number = forms.CharField(
        max_length=25,
        required=False,
        widget=forms.TextInput(attrs={
            'class': 'sdh-input',
            'placeholder': 'Phone number (e.g. +91 9876543210)',
            'autocomplete': 'tel',
        })
    )

    avatar = forms.FileField(
        required=False,
        widget=forms.FileInput(attrs={
            'class': 'hidden',
            'accept': 'image/jpeg,image/png,image/webp,image/gif',
            'id': 'id_avatar',
        })
    )

    class Meta:
        model = UserProfile
        fields = ('bio',)
        widgets = {
            'bio': forms.TextInput(attrs={
                'class': 'sdh-input',
                'placeholder': 'Short bio',
                'maxlength': 200,
            }),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance and self.instance.pk:
            if hasattr(self.instance, 'user') and self.instance.user:
                self.fields['first_name'].initial = self.instance.user.first_name
                self.fields['last_name'].initial = self.instance.user.last_name
            self.fields['phone_number'].initial = self.instance.phone_number

    def clean_phone_number(self):
        import phonenumbers
        phone = self.cleaned_data.get('phone_number', '').strip()
        if not phone:
            return None

        try:
            if phone.isdigit() and len(phone) == 10:
                parsed = phonenumbers.parse(f"+91{phone}")
            else:
                parsed = phonenumbers.parse(phone, 'IN')

            if not phonenumbers.is_valid_number(parsed):
                raise forms.ValidationError("Invalid phone number format.")

            formatted = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
            qs = UserProfile.objects.filter(phone_number=formatted)
            if self.instance and self.instance.pk:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise forms.ValidationError("This phone number is already registered to another account.")
            return formatted
        except phonenumbers.NumberParseException:
            raise forms.ValidationError("Invalid phone number. Include country code if outside India.")

    def clean_avatar(self):
        avatar = self.cleaned_data.get('avatar')
        if avatar and hasattr(avatar, 'read') and hasattr(avatar, 'size') and avatar.size > 0:
            from messaging.file_security import validate_uploaded_file
            try:
                validate_uploaded_file(avatar, allowed_categories=('image',), max_size=5 * 1024 * 1024)
            except forms.ValidationError:
                raise
            except Exception as exc:
                raise forms.ValidationError(str(exc))
        return avatar

    def save(self, commit=True):
        profile = super().save(commit=False)
        user = profile.user

        # Update User first/last name
        first_name = self.cleaned_data.get('first_name')
        last_name = self.cleaned_data.get('last_name')
        user_changed = False
        if first_name is not None and user.first_name != first_name:
            user.first_name = first_name
            user_changed = True
        if last_name is not None and user.last_name != last_name:
            user.last_name = last_name
            user_changed = True
        if user_changed and commit:
            user.save(update_fields=['first_name', 'last_name'])

        # Update phone number if provided or modified
        if 'phone_number' in self.cleaned_data:
            profile.phone_number = self.cleaned_data.get('phone_number')

        if commit:
            profile.save()

        # Handle avatar upload durably via avatar_service
        avatar_file = self.cleaned_data.get('avatar')
        if avatar_file and hasattr(avatar_file, 'read') and hasattr(avatar_file, 'size') and avatar_file.size > 0:
            from .avatar_service import upload_avatar
            avatar_url, err = upload_avatar(user, avatar_file)
            if err:
                raise forms.ValidationError(err)
            profile.refresh_from_db()

        return profile
