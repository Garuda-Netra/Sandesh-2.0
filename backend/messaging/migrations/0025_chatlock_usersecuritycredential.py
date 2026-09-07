# Generated manually for Chat Lock & User Security feature

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('messaging', '0024_autowishevent_is_approved_and_more'),
    ]

    operations = [
        migrations.CreateModel(
            name='UserSecurityCredential',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('pin_hash', models.CharField(blank=True, default='', max_length=255)),
                ('biometric_enabled', models.BooleanField(default=False)),
                ('biometric_credential_id', models.TextField(blank=True, default='')),
                ('biometric_public_key', models.TextField(blank=True, default='')),
                ('failed_attempts', models.PositiveIntegerField(default=0)),
                ('locked_until', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='security_credential', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'User Security Credential',
                'verbose_name_plural': 'User Security Credentials',
            },
        ),
        migrations.CreateModel(
            name='ChatLock',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('is_self_chat', models.BooleanField(default=False, help_text='True if the user has locked their Saved Messages')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('locked_group', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='+', to='messaging.group')),
                ('locked_user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='chat_locks', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'Chat Lock',
                'verbose_name_plural': 'Chat Locks',
                'unique_together': {('user', 'locked_user'), ('user', 'locked_group')},
            },
        ),
        migrations.AddIndex(
            model_name='chatlock',
            index=models.Index(fields=['user', 'locked_user'], name='messaging_c_user_id_41a8db_idx'),
        ),
        migrations.AddIndex(
            model_name='chatlock',
            index=models.Index(fields=['user', 'locked_group'], name='messaging_c_user_id_b0f19c_idx'),
        ),
    ]
