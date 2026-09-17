# Code com

O **Code com** é um aplicativo de conversa auto-hospedado para grupos de amigos,
com servidores e canais, mensagens em tempo real, chamadas de voz e transmissão
de tela. Ele roda no computador de quem hospeda e pode ser aberto no navegador
ou instalado como PWA no desktop e no celular.

O projeto combina uma API Python com FastAPI, SQLite para persistência e uma
interface web em HTML, CSS e JavaScript sem framework de front-end. WebSockets
entregam eventos do chat em tempo real; WebRTC conecta os participantes de voz e
transmite mídia diretamente entre navegadores. Não há serviço externo de banco
de dados obrigatório.

### O que já dá para fazer

- Criar servidores, canais de texto e voz, conversar por mensagem direta e
  enviar imagens e arquivos.
- Entrar em chamadas de voz, controlar o volume de cada participante e usar
  atalhos e preferências de áudio.
- Compartilhar uma janela, aba ou a tela inteira; quando o navegador e a fonte
  permitem, incluir o áudio da tela. A transmissão oferece alvos de 720p ou
  1080p a 30 ou 60 FPS.
- Instalar a interface como PWA e continuar vendo a tela de orientação offline;
  o servidor precisa estar ligado para usar contas, mensagens, voz e chamadas.
- Usar o app localmente, na mesma rede ou pela internet com HTTPS e um túnel.

O Code com é um projeto pessoal em desenvolvimento, pensado para uso entre
amigos. A seção de segurança documenta os limites atuais antes de expor uma
instância à internet.

---

## Como rodar

Clique duas vezes em **`iniciar.bat`** e abra <http://localhost:8000> no navegador.

Na primeira vez, crie uma conta com "Criar conta".

### Instalar como aplicativo no Desktop ou celular

O Code com pode ser instalado pelo Edge ou Chrome e abre numa janela própria.
A instalação fica associada ao endereço que você abriu no navegador.

**No notebook que hospeda o servidor:** use a pasta **`Codecom - Instalável`**
no Desktop e rode **`Abrir Code com.bat`** para usar o endereço local. Para os
amigos acessarem pela internet, rode **`iniciar_online.bat`** e envie a eles o
link `https://...trycloudflare.com` que aparecer. Essa pasta é só o iniciador
do servidor do anfitrião; os amigos não precisam baixar o código do GitHub nem
ter essa pasta.

**Para cada amigo instalar o atalho:** abra o link HTTPS recebido no Edge ou
Chrome e clique em **Instalar Code com** na tela de login ou nas configurações.
Se o botão não aparecer, use o menu **Aplicativos → Instalar Code com**. No
Android, também é possível usar **Instalar app** no menu do navegador; no
iPhone/iPad, abra no Safari e use **Compartilhar → Adicionar à Tela de Início**.
O atalho abre o app hospedado no notebook, então o computador e as janelas do
servidor e do túnel precisam continuar ligados.

O túnel gratuito do Cloudflare cria outro endereço ao reiniciar. Como o atalho
fica preso ao endereço usado na instalação, se o link mudar será preciso abrir
o novo link e instalar novamente. Para manter o mesmo atalho funcionando depois
de reinicializações, configure um túnel nomeado com um domínio próprio.

Mensagens, contas e chamadas não são armazenadas offline; a tela offline apenas
orienta como iniciar o servidor.

### Chamar a galera pela internet (jeito recomendado)

Rode **`iniciar_online.bat`**. Ele liga o servidor e abre um túnel da Cloudflare,
te dando um endereço público tipo:

```
https://motion-flow-promo-muscles.trycloudflare.com
```

Manda esse link pros amigos — funciona de qualquer lugar do mundo, e **a voz
funciona**, porque é `https://`.

Ele mostra o endereço numa caixa, **copia pra área de transferência** (é só colar
no WhatsApp) e abre o app pra você em `http://localhost:8000`.

Coisas pra saber:

- **o endereço muda toda vez** que você liga. É normal no túnel gratuito.
- **a janela preta tem que ficar aberta** — ela é o servidor. Ctrl+C desliga tudo.
- seus amigos precisam da **senha de convite** pra criar conta — está no arquivo
  `senha_de_convite.txt`. Trocar a senha ali não exige reiniciar nada.

### "O link não abre aqui na minha máquina"

Se aparecer o aviso sobre DNS: o roteador desta conexão demora (ou nunca)
a reconhecer endereços recém-criados. **Isso afeta só você** — quem está fora
resolve normalmente, então mande o link e peça pra alguém testar.

Você não precisa do link pra usar o seu próprio app: use `http://localhost:8000`.

Pra resolver de vez, troque o DNS do Windows para `1.1.1.1`:
*Configurações → Rede e Internet → sua conexão → Editar DNS → Manual → IPv4 ligado
→ DNS preferencial `1.1.1.1`*.

Precisa instalar o cloudflared uma vez só:

```
winget install Cloudflare.cloudflared
```

### Chamar a galera na mesma rede (mesmo wi-fi)

O `iniciar.bat` mostra o endereço, algo como `http://192.168.18.171:8000`.

Atenção: se o Windows estiver com a rede marcada como **Pública**, o firewall
bloqueia e ninguém consegue abrir — é preciso liberar o Python nas exceções.
Por isso o túnel costuma dar menos dor de cabeça.

### Voz na rede local, sem túnel

Navegador só libera microfone em `https://` ou em `localhost`. Pra ter voz na
rede local sem o túnel:

1. rode **`gerar_certificado.bat`** (uma vez só)
2. use **`iniciar_com_voz.bat`**
3. cada pessoa vai ver um aviso de "conexão não é particular" — é normal, o
   certificado é feito na sua máquina. Clicar em *Avançado → Prosseguir*.

---

## Os arquivos

| arquivo | o que faz |
|---|---|
| `server.py` | a API e o WebSocket. É aqui que as mensagens são recebidas e distribuídas |
| `db.py` | todo o acesso ao banco: usuários, servidores, canais, mensagens |
| `static/index.html` | a estrutura da tela |
| `static/style.css` | as cores e o layout |
| `static/app.js` | a lógica do cliente: WebSocket, desenhar mensagens, chamadas de voz |
| `discord.db` | o banco (criado sozinho na primeira execução) |
| `uploads/` | os arquivos que as pessoas enviam |

---

## Como funciona

### O tempo real

Num site comum o navegador pede uma página e a conexão fecha. Aqui a conexão
fica **aberta** (WebSocket), então o servidor consegue empurrar uma mensagem
sem o navegador pedir:

```
luiz digita  →  WebSocket  →  servidor salva no banco
                                    ↓
                    manda pra todo mundo do canal
                                    ↓
                        aparece na tela do amigo
```

### A voz

O áudio **não passa pelo servidor Python**. Cada par de navegadores abre uma
conexão direta entre si (WebRTC / P2P). O servidor só entrega os bilhetes de
apresentação — isso se chama *sinalização*:

```
luiz                    servidor                    amigo
  │── "quero falar" ───────→│                         │
  │                         │──── "o luiz quer" ─────→│
  │←──────────── "pode vir" ──────────────────────────│
  │                                                   │
  └═══════════ áudio direto, sem passar pelo servidor ═┘
```

Como é P2P, funciona liso na mesma rede. Pela internet aberta, redes mais
fechadas podem bloquear — aí seria preciso um servidor TURN.

---

## Segurança (o que já está resolvido)

- **Senhas** nunca são guardadas em texto puro: usam PBKDF2 com 200 mil rodadas
  e um sal aleatório por usuário.
- **Permissão é checada no servidor**, não na tela. Mesmo chamando a API na mão,
  ninguém lê canal de servidor onde não entrou nem apaga mensagem dos outros.
- **Upload** nunca usa o nome de arquivo que o usuário mandou (senão daria pra
  mandar `../../senha.txt` e escrever fora da pasta). O nome é sorteado e só a
  extensão é aproveitada, depois de limpa.
- **Mensagens** são inseridas com `textContent`, não `innerHTML`: mandar
  `<script>` no chat não executa nada.

- **Cadastro trancado**: só cria conta quem souber a senha do arquivo
  `senha_de_convite.txt`. Apagar a linha da senha deixa o cadastro aberto.

O que **não** está pronto pra internet aberta: não há limite de tentativas de
login, os tokens não expiram, e o SQLite não aguenta muita gente ao mesmo tempo.
Pra uso entre amigos, está ótimo.

---

## Perfil, amigos, tela e voz

- **Perfil**: clique no seu nome (canto inferior esquerdo) ou na engrenagem
  para trocar foto, nome de exibição, status, "sobre mim", cor e senha.
  Clicar em qualquer pessoa abre o cartão de perfil dela.
- **Amigos**: no cartão de perfil tem "Adicionar amigo". Os pedidos aparecem
  no topo da tela inicial com ✓ e ✕, e chegam na hora para a outra pessoa.
- **Compartilhar janela ou tela**: dentro de uma sala de voz, escolha
  **🪟 Janela/aba** ou **🖥️ Tela toda**. O seletor do navegador ainda permite
  confirmar a fonte. Só funciona em `https://` ou `localhost` (mesma regra
  do microfone), então use o `iniciar_online.bat`.

  **Para transmitir com som**, marque **Compartilhar áudio** no seletor do
  navegador. A disponibilidade depende do sistema operacional, navegador e
  fonte escolhida. O áudio do próprio Codecom é filtrado quando o navegador
  oferece esse recurso. Se não oferecer, só o áudio da tela é bloqueado na
  transmissão, para não devolver as vozes de quem está assistindo; quem
  transmite continua ouvindo a call. O painel indica quando o seletor não
  retornou áudio ou quando o filtro contra eco não está disponível.
  Quem assiste deve clicar em **Ativar som da chamada e das telas** caso o
  navegador bloqueie a reprodução automática. O som da tela é independente
  do botão de silenciar o microfone.

  Referências: [captura de tela e áudio](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
  e [permissão de reprodução](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play).

  Quem assiste vê num **visor flutuante** que aparece em qualquer tela — no
  computador é uma janelinha no canto inferior direito, no celular ocupa o
  topo. O **–** recolhe pra só a barrinha, e tocar no vídeo abre em tela
  cheia. Como o visor não fica preso ao chat, dá pra trocar de canal sem
  perder a transmissão de vista.

  No painel de voz, **Qualidade da transmissão** permite escolher **720p ou
  1080p, a 30 ou 60 fps**, antes ou durante a transmissão. O padrão é 1080p
  a 30 fps e a escolha fica salva neste navegador. Os tetos de vídeo por
  espectador são 4 Mbps (720p/30), 6 Mbps (720p/60), 8 Mbps (1080p/30) e
  12 Mbps (1080p/60). O envio preserva a resolução em vez de reduzir a imagem
  automaticamente quando mais pessoas entram. Como cada pessoa recebe uma
  cópia, o upload necessário aumenta com o número de espectadores.
  A resolução da fonte e o desempenho da conexão e dos dispositivos limitam
  o resultado real: selecionar 1080p/60 não transforma uma fonte menor em
  Full HD, e o navegador pode reduzir a taxa de quadros se faltar capacidade.
  Quando suportado, pedimos um buffer de recepção de 50 ms; isso é uma
  preferência, não uma garantia de atraso total. Internet, Wi-Fi e desempenho
  dos dispositivos continuam influenciando a transmissão.

- **Volume por pessoa (PC e celular)**: clique ou toque no nome de alguém
  na sala de voz, em **Ajustar volume** no perfil ou em **Volume** sobre o
  vídeo. Os controles de **Voz** e **Som da transmissão** são independentes:
  0% silencia, 100% mantém o original e até 200% amplifica. Só muda o que você
  ouve; as preferências ficam salvas por conta neste navegador e endereço.
  O ganho usa Web Audio para funcionar também em celulares. Navegadores sem
  Web Audio usam o controle nativo, limitado a 100% e ao suporte do aparelho.
- **Diagnóstico e adaptação da transmissão**: a sala mostra estado da conexão,
  latência, perda de pacotes e resolução/FPS enviados. Quando um espectador tem
  perda alta ou latência elevada por várias medições, o Codecom reduz o bitrate
  e o FPS apenas para aquela conexão; recupera gradualmente quando a rede volta
  a ficar estável. A resolução escolhida permanece como alvo.
- **Supressão de ruído**: ligada por padrão. São duas camadas — a do próprio
  navegador (`noiseSuppression`, contra chiado constante) e um **portão de
  ruído** nosso, que fecha o microfone quando você não está falando. A
  barrinha no painel de voz mostra o que está sendo captado: verde quando
  passa, cinza quando está sendo cortado. O botão **🎚️ Ruído** desliga.

  Isto **não** é o Krisp do Discord, que usa um modelo de rede neural treinado
  para separar voz de ruído. O portão resolve teclado e ventilador no silêncio,
  mas não remove barulho enquanto você fala.

## No celular

Funciona no navegador do celular, sem instalar nada. A tela vira duas: a lista
(servidores e canais) e a conversa; o **‹** no topo volta para a lista.

## Chat, aparência e atalhos

- **Responder, editar, apagar, reagir e fixar**: passe o mouse ou toque nas
  ações da mensagem. As respostas levam de volta à mensagem original, e a
  busca e o filtro de fixadas atuam no canal atual.
- **Fotos e arquivos**: imagens carregam conforme aparecem na conversa, abrem
  em tela cheia e o envio mostra progresso. O histórico começa pelas 50
  mensagens mais recentes e carrega as anteriores ao subir a conversa.
- **Rascunhos e conexão**: o texto não enviado fica salvo por canal neste
  navegador. Se o WebSocket cair, o app tenta reconectar com espera gradual,
  mantém o rascunho e atualiza o histórico quando volta.
- **Preferências**: a engrenagem no topo abre os temas Aurora, Violeta e Luz
  suave, seleção de microfone e saída de áudio, teste da saída, nível do mic,
  sons de chamada e push-to-talk. Com push-to-talk ligado, segure **V** para
  falar; o atalho não dispara enquanto você digita em um campo.
- A seleção de saída depende do suporte do navegador a `AudioContext.setSinkId`;
  se não houver suporte, os outros controles de áudio continuam disponíveis.

Ideias futuras incluem cargos e permissões, notificações de mensagens não lidas,
câmera e supressão de ruído por rede neural (RNNoise em WebAssembly).

## Verificar o áudio da tela

Com Node.js instalado, rode `node --test tests/screen-audio.test.cjs`.
Os testes simulam captura, envio das faixas, bloqueio de reprodução e encerramento.
Para validar os dispositivos reais, entre na mesma sala com dois navegadores,
compartilhe uma aba com áudio e marque **Compartilhar áudio**. No receptor,
confirme o som da aba e a voz; ao parar a tela, a voz deve continuar.

`node tests/browser-media.cjs` faz uma integração local em Chrome com Playwright
instalado: dois participantes trocam vídeo e dois áudios sintéticos por WebRTC.
Verifica os quatro perfis de vídeo, troca de qualidade ao vivo, ganho,
silenciamento separado, persistência e o painel em largura de celular e
desktop. A rede local precisa permitir conexões WebRTC; esse teste
não mede a latência da internet nem substitui a validação em um celular real.

Referências técnicas: [parâmetros de envio WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters),
[buffer de recepção](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget)
e [ganho com Web Audio](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/PlayingandSynthesizingSounds/PlayingandSynthesizingSounds.html).

`node tests/browser-chat-images.cjs` verifica a rolagem do chat com várias
fotos, o envio de um anexo (API simulada) e o campo de mensagem em quatro
tamanhos de janela, incluindo celular. Requer Playwright e Chrome.
