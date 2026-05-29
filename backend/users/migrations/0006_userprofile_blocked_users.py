from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users', '0005_userprofile_hidden_users'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='blocked_users',
            field=models.ManyToManyField(
                blank=True,
                help_text='Profiles blocked by this user.',
                related_name='blocked_by',
                symmetrical=False,
                to='users.userprofile',
            ),
        ),
    ]
