from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0010_usersettings'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='e2e_public_key',
            field=models.JSONField(blank=True, help_text="User's ECDH P-256 public key (JWK format) for end-to-end encryption", null=True),
        ),
    ]
