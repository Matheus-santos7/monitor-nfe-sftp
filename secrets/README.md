Coloque aqui a chave privada SSH do bastion do Nerus como `bastion.pem`. O compose já usa `./secrets/bastion.pem` por padrão; só defina `NERUS_SSH_KEY_HOST_PATH` no `.env` se a chave estiver em outro lugar.

```bash
chmod 600 secrets/bastion.pem
```

Este diretório não vai para o Git, exceto este README.
