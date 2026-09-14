from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('messaging', '0028_message_is_encrypted_message_encryption_iv_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='message',
            name='is_view_once',
            field=models.BooleanField(default=False, help_text='View once media that disappears permanently after viewing'),
        ),
        migrations.AddField(
            model_name='message',
            name='view_once_opened',
            field=models.BooleanField(default=False, help_text='True once opened by recipient'),
        ),
        migrations.AddField(
            model_name='message',
            name='view_once_opened_at',
            field=models.DateTimeField(blank=True, help_text='Timestamp when view-once media was opened', null=True),
        ),
        migrations.AddField(
            model_name='groupmessage',
            name='is_view_once',
            field=models.BooleanField(default=False, help_text='View once media that disappears permanently after viewing'),
        ),
        migrations.AddField(
            model_name='groupmessage',
            name='view_once_opened',
            field=models.BooleanField(default=False, help_text='True once opened'),
        ),
        migrations.AddField(
            model_name='groupmessage',
            name='view_once_opened_at',
            field=models.DateTimeField(blank=True, help_text='Timestamp when view-once media was opened', null=True),
        ),
    ]
