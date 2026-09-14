from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('messaging', '0027_alter_chatsetting_retention_days'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='message',
            name='is_encrypted',
            field=models.BooleanField(default=False, help_text='Indicates if the message content is end-to-end encrypted'),
        ),
        migrations.AddField(
            model_name='message',
            name='encryption_iv',
            field=models.CharField(blank=True, default='', help_text='Base64-encoded AES-GCM initialization vector', max_length=64),
        ),
        migrations.AddField(
            model_name='groupmessage',
            name='is_encrypted',
            field=models.BooleanField(default=False, help_text='Indicates if the group message content is end-to-end encrypted'),
        ),
        migrations.AddField(
            model_name='groupmessage',
            name='encryption_iv',
            field=models.CharField(blank=True, default='', help_text='Base64-encoded AES-GCM initialization vector', max_length=64),
        ),
        migrations.CreateModel(
            name='GroupE2EKey',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('encrypted_key', models.TextField(help_text="Base64 ciphertext of AES group key encrypted with user's ECDH public key")),
                ('encryption_iv', models.CharField(blank=True, default='', help_text='Base64 IV used when encrypting the group key', max_length=64)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('group', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='e2e_keys', to='messaging.group')),
                ('sender', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='distributed_group_keys', to=settings.AUTH_USER_MODEL)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='group_e2e_keys', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'Group E2E Key',
                'verbose_name_plural': 'Group E2E Keys',
                'unique_together': {('group', 'user')},
            },
        ),
    ]
