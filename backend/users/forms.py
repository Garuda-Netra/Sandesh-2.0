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
    Form for updating the UserProfile bio and avatar.
    """
    class Meta:
        model = UserProfile
        fields = ('bio', 'avatar')
        widgets = {
            'bio': forms.TextInput(attrs={
                'class': 'sdh-input',
                'placeholder': 'Short bio',
                'maxlength': 200,
            }),
        }
