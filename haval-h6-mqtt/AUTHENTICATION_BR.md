# Autenticação GWM Brasil — versão 1.0.9.3

Esta atualização adapta o add-on às mudanças da API brasileira de novembro de
2026. Mantém os tópicos MQTT, os identificadores de entidades e os controles
existentes de temperatura e duração do ar-condicionado.

## Instalar a atualização

Depois que a correção estiver no `main` do seu repositório:

1. Faça um backup do add-on com seus dados.
2. Em **Settings → Add-ons → Add-on Store → ⋮ → Check for updates**, atualize
   as informações dos repositórios.
3. Abra **GWM Brasil com MQTT - MF** e instale a versão **1.0.9.3**.
   Se o Supervisor oferecer **Rebuild** em vez da atualização, reconstrua o add-on.
4. Mantenha as opções MQTT, o VIN e o PIN existentes.

Não é necessário desinstalar o add-on nem remover suas entidades MQTT.

## Conta exclusiva para o Home Assistant

A GWM passou a encerrar a sessão anterior quando a mesma conta entra em outro
dispositivo. Para usar o aplicativo no telefone e o HA simultaneamente:

1. Crie uma segunda conta My GWM.
2. Compartilhe o veículo da conta proprietária com essa conta. Confirme que o
   veículo realmente aparece para ela no aplicativo antes de configurar o add-on.
   Há relatos de que manter a conta convidada aberta em um segundo telefone
   facilita concluir o compartilhamento no aplicativo brasileiro.
3. Conceda as permissões desejadas. Para comandos remotos, confira também o PIN
   de controle dessa conta; o PIN não é o código recebido por e-mail.
4. Saia da conta secundária no aplicativo e use-a somente no add-on.
5. No telefone, continue usando a conta proprietária.

## Primeiro login com código por e-mail

1. Nas opções do add-on, configure `gwm_username` e `gwm_password` com a conta
   dedicada. Deixe `gwm_verification_code` vazio ou ausente e inicie o add-on.
2. Abra **Log**. Se a GWM exigir verificação de novo dispositivo, o add-on
   solicitará o código por e-mail e mostrará uma instrução para preenchê-lo.
3. Em **Configuration**, habilite **Show unused optional configuration options**
   se necessário. Preencha **Código de verificação GWM (temporário)**, cujo nome
   YAML é `gwm_verification_code`, com o código recebido. Exemplo de formato:

   ```yaml
   gwm_verification_code: "012345"
   ```

   Mantenha como texto para preservar zeros à esquerda. Salve e reinicie o add-on.
4. O add-on verifica o código e conclui o login com a mesma identificação de
   dispositivo. O log deve prosseguir para a descoberta e o registro do veículo.
5. Após o sucesso, remova o código das opções. Ele não é usado na renovação da
   sessão. Se a remoção exigir reiniciar, a sessão salva será reutilizada.

Um código incorreto não é reenviado indefinidamente: informe o código correto
e reinicie. Para solicitar outro e-mail, deixe o campo vazio e aguarde pelo menos
dez minutos desde a solicitação anterior. O add-on limita os pedidos e preserva
a solicitação pendente entre reinícios. Depois de solicitar outro código,
preencha o novo valor e reinicie.

## Sessão e diagnóstico

- Dispositivo, tokens e `gwId` são persistidos no armazenamento privado existente
  do add-on (`/data/storage`). Os tokens antigos do login do portal são ignorados.
- A expiração do access token dispara renovação pelo refresh token; os novos
  tokens são salvos antes da próxima consulta. Quando o refresh token é
  definitivamente recusado, um novo login pode exigir outro código por e-mail.
- **607501:** a conta entrou em outro dispositivo. O add-on bloqueia novas
  requisições nessa execução para evitar disputa de sessão. Saia dessa conta no
  aplicativo e reinicie o add-on. Prefira a conta dedicada.
- **308001:** conta ou senha recusada. Confira as credenciais; alterações de senha
  invalidam a sessão anterior. Há uma pausa de cinco minutos entre tentativas
  recusadas, que persiste nos reinícios.
- **418 / 607012:** bloqueio HTTP ou assinatura recusada. Confira a versão instalada
  e envie o log resumido, sem credenciais, para diagnóstico.
- **429:** o add-on respeita o tempo de espera informado pela GWM, com mínimo de
  cinco minutos; reiniciar não remove essa espera.
- Falhas de rede ou respostas incompletas durante a renovação preservam a sessão
  salva. Erros de autenticação não registram senha, código ou tokens no log.

## Escopo da validação

Os testes automatizados são locais, com respostas simuladas e certificados já
existentes no repositório. Cobrem assinatura, OTP, reinício, renovação, conflitos,
limites de requisição e o caminho do comando de ar-condicionado com temperatura
e duração. Nenhuma credencial real foi utilizada e nenhum comando foi enviado
a um carro.

Após instalar, valide primeiro descoberta do carro, atualização dos sensores,
reinício mantendo a sessão e funcionamento por mais de 24 horas. Só depois
valide os comandos remotos desejados. A aceitação dos comandos pela API nova
ainda precisa de confirmação real no seu Haval H6 PHEV19 2027.

## Referências

- [Diagnóstico do add-on, issue 33](https://github.com/havaleiros/hassio-haval-h6-to-mqtt/issues/33)
- [Implementação de referência f771372](https://github.com/moryoav/ha-gwm-ev/tree/f7713729de428ce15f35416222d1824e77033de3)
- [Relatos dos testes brasileiros](https://github.com/moryoav/ha-gwm-ev/issues/59)
- Atribuição e licença em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
