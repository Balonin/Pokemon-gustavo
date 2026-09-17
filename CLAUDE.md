# Pokémon Gustavo — contexto do projeto

App de fichas e deck building para o sistema de RPG caseiro "Pokémon Gustavo",
com salas de Mestre/Jogador e um modo de batalha.

Responda sempre em **português do Brasil**.

## Stack

- Backend: Node + Express (`server.js`), sem framework de frontend
- Banco: PostgreSQL via `pg`; sem `DATABASE_URL` cai para um store em memória
- Frontend: **um único arquivo** `public/index.html` (HTML + CSS + JS puro, sem build)
- Deploy: Render (Web Service). `git push` na branch `main` dispara deploy automático

## Estrutura

```
server.js          API REST + regras de permissão
package.json
public/index.html  aplicação inteira (~490 KB, inclui as bases de dados)
```

Não há etapa de build. O que está em `public/` é servido direto.

## Regras do sistema (importantes para não quebrar cálculos)

Os Status são HP, ATK, DEF, SPA, SPD, SPE.

- **Status inicial**: 10% do Status base da forma inicial da linha evolutiva,
  arredondando para cima só a partir de fração ≥ 0,6 (função `roundStatus`)
- **Por nível**: +1 em todos os Status até o nível 40, e +1 ponto livre por nível
- **Evolução**: +5 em todos os Status e +2 pontos livres na 1ª evolução;
  +5 e +3 na 2ª. Quem evolui só uma vez recebe +10/+5 de uma vez
- **Nível 40**: o bônus retido só é concedido se o Pokémon já estiver na forma final
  ou se o treinador marcar `committed` (decidiu nunca mais evoluir)
- **Lendários/Pseudo-lendários**: recebem +15 em vez de +10 no total
- **Teto**: nenhum Status passa de **90** — exceto o **HP, que não tem teto**
- **Mega / Battle Bound** (só enquanto ativa na batalha): depois da distribuição, **+10% em cada
  Status** (inclusive HP), com o arredondamento do crítico (`roundStatus`), e o teto vira **95** (HP
  segue sem teto). Ex.: 90 → 90 + 9 = 99 → 95; 85 → 85 + 8 = 93. Tudo em `finalStatsFor`
  (`megaFormOf(m)` diz se está ativa)
- **Status extra (homebrew)**: `bonus` da ficha = `{ hp, atk, … }` (inteiros −99…99, só os ≠ 0; `cleanBonus`
  no servidor). Soma em `finalStatsFor` **antes do teto de 90** (HP sem teto; a Mega vem depois), então
  entra em tudo que usa Status: HP máximo, margem de crítico, estágios, batalha. Só o Mestre dá ou tira
  (botão "✚ Extra" no topo da ficha, que só ele vê; salva com "Salvar Ficha"); salvar como jogador mantém
  o `bonus` que está lá. O dono **vê os totais, sem marcação**; o Mestre vê marcas discretas em lilás
  (`bonus-mark` na ficha, `bonus-sup` na arena) com o quanto soma de fato (`bonusEffectOf`, "+0" se o teto
  comeu). Elementos `gm-only` ficam fora do "Copiar imagem" (`ignoreElements` do html2canvas)
- **Imagem personalizada da ficha**: botão 🖼 na moldura da arte → janela com o mesmo enquadramento do
  avatar (o editor `#avCrop` é um só e muda de lugar: `openCrop(img, state, opts)` com `AVATAR_CROP` /
  `MON_ART_CROP`). Duas imagens: a do Pokémon (`customArt`, aba normal) e a **própria da Mega / Battle
  Bound** (`megaSheet.art`, aba da Mega — o Battle Bound costuma ter visual diferente). Fica pendente no
  rascunho (`{ data, pixel }`) e sobe ao salvar a ficha: vira arquivo na tabela `media` (`POST /api/media`
  aceita webp/png/jpeg até 2 MB, nunca SVG) e a ficha guarda só `{ id, pixel }` (`cleanCustomArt`).
  Jogador só usa imagem que ele enviou; trocar, tirar, "Sem Mega" ou excluir a ficha apaga o arquivo
  antigo (`artIdsOf`/`releaseArt`). Aparece **só na ficha e na arte de fim de batalha** (`artRefOf`/
  `customArtOf`; Mega ativa: a imagem da Mega, senão sprite da Mega oficial / imagem do Pokémon no Battle
  Bound; na visão pública vai já escolhida como `art` no `seen`, por `artShownFor`); a arena continua com o
  sprite oficial.
  **Qualidade**: o recorte é alinhado a pixels inteiros e guardado no tamanho original (até 1024 px), então o
  arquivo não perde nada; o que muda é como é **mostrado**. `analyzePicture` olha a imagem nos pixels dela:
  poucas cores (≤ 1200) → PNG sem perda, senão WebP; e **pixel art = bordas duras**: onde a cor muda de
  verdade (A → B), pixel art vai direto e ilustração/foto põe uma mistura de A e B no meio (antialiasing, em
  RGBA pré-multiplicado, então borda suave contra transparência conta). Menos de 35% de bordas com mistura
  → pixel art, ampliada nítida (`image-rendering: pixelated`), de qualquer tamanho; o resto é suavizado.
  Não usar tamanho nem só contagem de cores: arte oficial chapada tem poucas cores, e pixel art grande
  existe. O `pixel` dá pra trocar na janela (controle "Pixel art"), inclusive numa imagem já salva. Na arte
  de fim de batalha só sprites oficiais e pixel art pequena (até 96 px) entram no desenho de 640×360; toda
  imagem maior (inclusive pixel art) é pintada **depois** da ampliação 2×, suave e na resolução final
  (`overlays` em `drawBattleArt`). O retrato do treinador também (`portraits`): usa a imagem da ficha do
  treinador em alta (`art` em `trainerInfo`/`roomTrainers`), senão o avatar de 96 px — nunca mais reduzido
  a blocos; avatar de sprite de Pokémon continua como sprite
- **HP em batalha** = Status de HP × 2
- **Margem de crítico** = 10% do Status (mesmo arredondamento)
- **Estágios de Status**: cada estágio vale 10% do Status original, limite de ±6.
  HP não recebe estágio. Na arena cada caixa mostra o Status normal e o que os estágios somam
  ("60 +6"), com o número de estágios embaixo e, no canto, a margem de crítico — que **não muda
  com os estágios** (sempre 10% do Status normal; a Mega ativa muda, porque muda o próprio Status).
  A caixa de HP só tem Status e margem
- **Dado de dano de um golpe** = poder do jogo ÷ 2, arredondado para baixo
  (ex: Tackle 40 → 1d20)
- **Accuracy**: acerta tirando ≤ (Status × accuracy do golpe) num d100

Funções relevantes em `public/index.html`: `roundStatus`, `evoStepsFor`,
`computeFixedAndPoints`, `finalStatsFor`, `critMarginFor`, `effectiveStat`.

## Papéis e permissões

- Quem cria a sala é **Mestre**; quem entra pelo código/link é **Jogador**
- **Campanha (sala)**: só o Mestre, pelo ⚙ ao lado do nome, renomeia (`PUT /api/room { name }`) ou
  exclui (`DELETE /api/room { confirm: <nome da campanha> }` — o servidor confere o nome). Excluir apaga
  tudo da sala numa transação (`store.deleteRoom`: batalhas, fichas, times, NPCs, músicas e membros);
  os tokens morrem, e quem estava dentro volta pro lobby na próxima atualização (`token_invalido`), com
  só aquela sala saindo da lista de recentes (`forgetSession`). O nome novo chega a todos por
  `/api/state` (`applyState`)
- **Expulsar jogador**: o Mestre, no botão "Expulsar da campanha" da barra lateral do jogador, chama
  `DELETE /api/members/:nome { deleteData, block }`. Apaga todos os tokens desse nome (todos os
  aparelhos). `deleteData` apaga fichas, times, músicas e as batalhas em que ele luta (como no NPC);
  sem isso as fichas ficam com o Mestre, no treinador marcado "fora da campanha" (`gone` em
  `roomTrainers`), e voltam pro jogador se ele entrar de novo com o mesmo nome. `block` põe o nome em
  `rooms.banned` (JSON; comparação sem diferenciar maiúsculas), e a entrada recusa com
  `nome_bloqueado`. Só o Mestre recebe `room.banned`; desbloqueia no ⚙ (`DELETE /api/room/banned/:nome`).
  É bloqueio por nome — sem senha, quem tem o código entra com outro nome
- **Nome de login × personagem**: o nome digitado no lobby (`members.name`) é a identidade — é
  ele que está no `owner` das fichas e não muda (vai virar o login com senha). O **personagem**
  (`members.char_name`, `character` no JSON) é por sala, pode mudar a qualquer hora
  (`PUT /api/me/character`) e é o que aparece pros outros (`roomTrainers`, `trainerInfo`); vazio =
  mostra o nome de login. Ao entrar numa sala sem personagem, a janela de caracterização abre sozinha.
  O Mestre vê os dois: na ficha ("Ash · jogador: Diogo"), na barra lateral, na dica da coluna de
  treinadores e na escolha de dono de ficha nova (`loginOf`, que é o `owner` da ficha)
- **Ficha do treinador**: o ícone do topo abre a ficha do personagem, no formato da ficha de Pokémon —
  seis Status livres **FOR, CON, SAB, INT, DES, CAR** (0…90, mesmo teto; sem pool de pontos; o canto mostra
  a margem de crítico, 10%), **um quadro de anotações** no lugar dos golpes e a imagem com o nome (a
  imagem própria da ficha, em alta, pelo 🖼 — mesma janela/enquadramento da ficha de Pokémon — ou o ícone).
  "Nome, ícone e música" abre a janela de caracterização. Fica em `members.sheet` (JSON, em todos os tokens
  do nome, como o avatar; `cleanTrainerSheet`). Cada um salva a sua (`PUT /api/me/sheet`); o Mestre vê
  (`members[].sheet`) e edita a de qualquer jogador (`PUT /api/members/:nome/sheet`, pelo "📜 Ficha do
  treinador" da barra lateral). Imagem segue as regras da imagem de ficha e some ao trocar ou na expulsão.
  **Clicar no ícone de um treinador abre a ficha dele, como um perfil** (faixas da arena, cartões da lista de
  batalhas; pro Mestre também o topo da barra lateral e o dono da ficha — `data-profile`,
  `data-profile-battle`, `data-open-trainer`, `openBattleTrainer`). Mestre: a ficha completa e editável (NPC:
  perfil sem Status). Jogador: a própria, editável; a de outro, **só leitura** (`openTrainerProfile`) com
  nome, imagem e Status — que vêm em `trainerInfo` (`stats`, `art`). **As anotações nunca saem do servidor
  pra outro jogador**
- Cada pessoa recebe um **token** salvo no `localStorage` e enviado no header
  `Authorization: Bearer <token>`
- **As permissões são aplicadas no servidor**, não no cliente:
  - Jogador só lê e edita as próprias fichas
  - Mestre lê e edita todas as fichas da sala
  - Ao editar ficha alheia, o Mestre **preserva o `owner` original**
  - Ao **criar** uma ficha, o Mestre pode escolher o dono: ele mesmo, um jogador da sala
    ou um NPC da sala (`isValidOwner` no servidor). Jogador sempre cria pra si
- **NPCs**: treinadores criados só pelo Mestre (tabela `npcs`). Fichas de NPC têm
  `owner = "npc:<id>"`, então renomear o NPC não quebra nada e nenhum jogador vira
  dono delas digitando um nome. Nomes de treinador começando com `npc:` são recusados.
  Excluir um NPC exclui as fichas dele
- **Avatar** do treinador (coluna `members.avatar`, e `npcs.avatar`): `''` (placeholder
  com a inicial), `mon:<id da Pokédex>` (sprite) ou data URL raster de 96×96
  (`cleanAvatar` recusa SVG). Fica sincronizado em todos os tokens do mesmo nome.
  O Jogador escolhe ao entrar na sala e troca depois pelo ícone no topo. Imagem enviada passa por um
  enquadramento antes (`openCrop`/`applyCrop`): arrastar, zoom (controle, roda do mouse, pinça) e prévia
  em 96 e 32 px; o quadrado na tela é exatamente o avatar. "Ajustar enquadramento" reabre enquanto a
  janela está aberta (a imagem original não é guardada no servidor, só o 96×96)
- Só o Mestre recebe `members` e `npcs` em `/api/state`
- **HP e estágios de batalha** (`battle` da ficha) só o Mestre altera. Jogador pode reordenar
  as próprias fichas (`order`), e salvar uma ficha preserva `battle` e `order`
- **Batalhas** (tabela `battles`): o Mestre cria (`POST /api/battles`) com dois lados — jogador,
  NPC ou ele mesmo — e o time de cada um (até 6), troca o Pokémon em campo e encerra/exclui.
  `revealed` guarda todo Pokémon que já esteve em campo
- **Visibilidade na batalha, como nos jogos**: o jogador recebe em `/api/state` **todas** as
  batalhas da sala, já filtradas. As que ele luta vêm de `playerBattleView` — o próprio time
  completo e, do adversário, só o que `publicSideView` deixa: o Pokémon em campo (espécie, nível,
  tipos, HP em %, estágios, condição), o tamanho do time e os já utilizados (esses com o HP só em %
  e quem está em campo, que a arte de fim de batalha usa). Golpes, Status,
  ability, notas, ids e HP exato do outro lado nunca saem do servidor. O cliente do Mestre grava
  `maxHp` junto do `hp` pra essa porcentagem
- **Modo espectador**: as batalhas em que o jogador **não** luta vêm de `spectatorBattleView`
  (`spectator: true`, `field: { a, b }`), com os **dois lados** como adversário (`publicSideView`)
  e o log de `logForPlayer(b, null, …)` — HP só em %, nada de Pokémon que não entrou em campo.
  No cliente, `battleView` monta os dois lados com `full: false` e a arena usa `foePanelHtml` nos
  dois painéis (sem golpes nem HP em número); a barra lateral continua com as fichas do jogador.
  A aba "⚔ Batalhas" lista todas pra todo mundo (Em andamento / Encerradas), com "👁 Assistir"
  nas alheias; aviso e botão pulsando só pras batalhas em que o jogador luta
- **Log da batalha** (`battle.log`, até 300 entradas): escrito **pelo servidor** a partir das ações
  do Mestre — criação, trocas (`PATCH /api/battles/:id`), mudanças de HP/estágio
  (`PATCH /api/pokemon/:id/battle`, via `battleChangeEvents`) e fim/reabertura. Guarda ids de
  ficha; o jogador recebe a versão de `logForPlayer`: sem nada de Pokémon adversário que nunca
  entrou em campo e com o HP do adversário só em %
- **Música tema** (`members.theme` / `npcs.theme`, JSON `{ kind, ref, title }`): arquivo enviado
  (`kind: 'file'`, bytes na tabela `media`, até 8 MB, servido em `/media/<id>` com Range), link
  direto de áudio, YouTube, Spotify ou SoundCloud. Links passam por `parseThemeLink` no servidor
  e os players são montados só a partir do id — nunca do link colado. Jogador só usa arquivo que
  ele mesmo enviou; trocar/remover o tema apaga o arquivo antigo. Na arena, `syncBattleMusic`
  reveza os temas dos dois lados (um acaba, entra o outro); com um só, repete. Sem nenhum, toca
  `DEFAULT_BATTLE_THEME` (no `index.html`): a música de batalha contra treinador de Diamond/Pearl/
  Platinum, no YouTube (`qtzPna9yFjg`)
- **HP depois da batalha**: ao encerrar, o servidor guarda em `battle.final` o `battle` (HP/estágios)
  de cada Pokémon dos dois times e **cura as fichas** pra próxima batalha — exceto as que ainda
  estão em outra batalha em andamento. A batalha encerrada é exibida a partir de `final`
  (`battleMon` no cliente; `playerBattleView` no servidor; o jogador recebe `mine.final`) e fica
  sem controles. Reabrir devolve às fichas o estado de `final`
- **Terastalizar**: a ficha guarda `teraType` (um dos 18 tipos ou `Astral`; vazio = o 1º tipo),
  escolhido na janelinha do botão "Tera" embaixo da arte. Na batalha, o Mestre ativa com
  `PATCH /api/battles/:id { tera: { side, monId } }` — **um por lado por batalha** (como nos
  jogos), desfazível com `{ tera: { side, clear: true } }`; fica em `battle.tera[side] = { mon, type }`.
  Enquanto terastalizado o Pokémon defende só com o tipo Tera (`defTypes`; Astral mantém os tipos).
  O tipo Tera do adversário **só vai pro jogador depois de usado**
  Visual: não existem sprites 2D de Tera, então `makeTeraSprite` gera um (tinge o sprite com a cor
  do tipo, facetas de cristal, contorno escuro e uma joia pixelada na cabeça) e guarda em cache
- **Dynamax / Gigantamax**: dobra o HP (máximo e atual) e o dano dos golpes (`1dX×2`); os golpes
  aparecem como golpes Max do tipo (`MAX_MOVE`), Max Guard nos de status, e no Gigantamax o do tipo
  exclusivo vira o G-Max (tabela `GMAX`: sprite oficial do PokeAPI + golpe). Mestre ativa com
  `PATCH /api/battles/:id { dmax: { side, monId, gmax } }` (só o Pokémon em campo, **um por lado por
  batalha**), encerra com `{ end: true }` (HP volta pela metade, arredondando pra cima) ou desfaz com
  `{ clear: true }`; trocar o Pokémon também encerra. O estado fica em `battle.dmax` da ficha
  (`'dmax'`/`'gmax'`, que faz `maxHpOf` dobrar) e em `battle.dmax[side]` da batalha. Pode junto com o
  Tera e com a Mega. Visual: Gigantamax usa o sprite oficial com aura vermelha;
  Dynamax comum fica 28% maior com aura vermelha
- **Mega Evolução / Battle Bound**: o botão com o símbolo da Mega no topo da ficha (todos os
  Pokémon) só **escolhe qual Mega a ficha pode usar** — `mega` = `''`, o nome de uma Mega oficial
  (`'Mega Charizard X'`) ou `'bb'` (Battle Bound: a Mega do RPG, com golpe e passiva de assinatura).
  A ficha fica sempre na forma normal. Escolher a Mega **cria a ficha da Mega**, presa ao Pokémon
  (`megaSheet = { ability, moves }` dentro da própria ficha, limpa por `cleanMegaSheet` no servidor):
  a ability e os golpes que ele usa Mega Evoluído — onde vão a passiva e o golpe de assinatura do
  Battle Bound sem mexer na ficha normal. Começa com a ability da Mega oficial (Battle Bound: vazia)
  e uma cópia dos golpes. Na ficha aparecem as abas "Ficha | <Mega>" (`sheetMega`, `renderSheetTabs`);
  na ficha da Mega só ability e golpes são editáveis (Status = ficha +10%, nível/nature/distribuição
  vêm da normal, `megaViewOf`). Na barra lateral ela aparece presa embaixo do Pokémon
  (`sidebarMegaItem`). "Sem Mega" apaga a ficha da Mega (pergunta antes). Na batalha, com a Mega
  ativa, entram a ability e os golpes dela (`battleAbilityOf`, `battleMovesOf`).
  **Quem ativa é o Mestre, na batalha**: `PATCH /api/battles/:id { mega: { side, monId, t1, t2,
  ability, hp, maxHp } }` (só o Pokémon em campo, **uma por lado por batalha**, desfazível com
  `{ side, clear: true, hp, maxHp }`). Ativa, fica em `battle.mega = { form, t1, t2, ability }` da
  ficha (tipos/ability só da Mega oficial, que vêm da tabela `MEGA` do cliente) e em
  `battle.mega[side] = { mon, form }` da batalha; o HP ganha o que o +10% acrescenta
  (`megaHpFields`). Continua ativa ao trocar (como nos jogos); "Restaurar" mantém; a cura de fim de
  batalha tira. Mega oficial (97 formas do PokeAPI) troca **tipos, ability e sprite** enquanto ativa
  (`battleTypesOf`, `battleAbilityOf`, `spriteIdOf`). 9 Megas novas não têm ability no PokeAPI (mantém
  a do Pokémon) e a Mega Zygarde não tem sprite. O adversário só fica sabendo da Mega depois de
  ativada (`fieldView.megaActive`). Pode junto com Tera e Dynamax. Fichas antigas salvas com a Mega
  "ligada" (tipos trocados, originais em `megaBase`) são lidas de volta na forma normal
  (`withoutLegacyMega`, e `typesInBattle` no servidor)
- **Condições de status**: `battle.status` na ficha (`brn`, `par`, `slp`, `psn`, `tox`, `frz`) e
  `battle.confused` (acumula). Só o Mestre altera (é o mesmo `battle` do HP), aparecem pro
  adversário e no log, e somem no "Restaurar" e na cura de fim de batalha
- **Clima e terreno**: um de cada por batalha, em `battle.weather` / `battle.terrain` = `{ kind, turns }`
  (`turns: null` = sem limite; os climas primitivos são sempre assim). Só o Mestre muda, com
  `PATCH /api/battles/:id { weather: { kind, turns } | { delta: ±1 } | { clear: true } }` (idem
  `terrain`); chegar a 0 turnos encerra, como nos jogos. O servidor valida os tipos
  (`WEATHER_KINDS`/`TERRAIN_KINDS`, `applyFieldEffect`) e escreve início/fim no log; nomes, efeitos,
  cores e mensagens ficam nas tabelas `WEATHER`/`TERRAIN` do cliente. É público (vai em `battleHeader`
  pra jogador e espectador). Na arena: faixa acima da cena com −/+/✕ (`fieldBarHtml`), janelinha
  de escolha (`#fieldModal`, `renderFieldModal`) e o efeito na cena (classes `wx-*`/`tr-*`).
  A Neve (Snow) não tira HP, como no Scarlet/Violet; quem tira é o Granizo (Hail)
- **Armadilhas (entry hazards)**: ficam num lado do campo e pegam quem entra ali, como nos jogos.
  `battle.hazards[side] = { sr, spikes, tspikes, web, steelsurge }` — só o que está posto, cada um até
  o seu número de camadas (`HAZARD_LAYERS` no servidor: Espinhos 3, Espinhos Tóxicos 2, o resto 1).
  Só o Mestre muda, com `PATCH /api/battles/:id { hazard: { side, kind, layers } | { side, kind, delta }
  | { side, kind, clear: true } | { side, clear: 'all' } }` (`applyHazard`, que escreve no log); é público,
  vai no `battleHeader` pra jogador e espectador. Nomes, efeitos e cores ficam na tabela `HAZARD` do
  cliente. Na janela do campo (⚙ "🌦 Clima / Terreno / Armadilhas") o Mestre põe uma camada por clique e,
  no limite, o clique tira; o ✕ do lado varre tudo (Rapid Spin, Defog). Na arena aparecem como selos no
  chão de cada lado (`hazardZoneHtml`, `.hz-zone`), e no painel do Mestre vem uma fila **"Ao entrar"** com
  o dano já calculado (`residualRowHtml`): Stealth Rock e Espinhos de Aço = 1/8 do HP vezes a
  fraqueza/resistência ao tipo (pega até quem voa), Espinhos = 1/8, 1/6 ou 1/4 só pra quem está no chão,
  e lembretes de Espinhos Tóxicos (veneno) e Teia Elástica (SPE −1). É dano indireto (`reason` `sr`,
  `spikes`, `steelsurge`), então **não quebra Illusion**
- **Illusion (Zoroark, Zoroark de Hisui, Zorua)**: ability `Illusion` (ou "Ilusão"). Ao entrar em campo
  (criação da batalha ou troca) fica disfarçado do **último Pokémon do time que ainda não desmaiou** (se esse
  é ele mesmo, sem disfarce): `battle.illusion[side] = { mon, as }`, decidido no servidor
  (`applyIllusionOnEntry`). Quem não sabe (adversário, espectador) recebe o disfarce: `publicSideView` monta
  a visão com espécie/nome/nível/tipos do disfarce e HP/estágios/condições reais; o log grava `as` e
  `logForPlayer` troca o nome. Só **dano de golpe** quebra (`breakIllusion`): HP perdido sem `reason` de fim
  de turno (−10/−5/−1/Dano); clima, status e as frações (`reason: 'residual'`) não. Mestre também desfaz
  pelo botão (`PATCH { illusion: { side, clear } }`). Sair de campo sem ser descoberto: o adversário continua
  lembrando do disfarce (`illusionSeen`); voltando, disfarça de novo. O Mestre vê o real com "🎭 como X"; o
  dono vê o próprio Zoroark com a cara do disfarce (`mine.illusion`)
- **Imposter / Transform (Ditto)**: ability `Imposter` transforma **ao entrar** no Pokémon em campo do outro
  lado (o primeiro que vê). O cliente do Mestre monta a cópia (`transformSnapshot`: aparência — a da Mega,
  se ativa —, tipos, Status menos HP, ability, golpes, estágios e Tera; **Dynamax não**) e manda
  `PATCH { transform: { side, snapshot } }` (`cleanTransform`); fica em `battle.transform` da ficha e
  `transformOf` faz `spriteIdOf`/`battleTypesOf`/`battleAbilityOf`/`battleMovesOf`/`finalStatsFor` usarem a
  cópia. O adversário vê o nome dele e a aparência copiada (`transformed`, `transformSprite`). Sair de
  campo desfaz; botões "🔄 Transformar" (Imposter ou golpe Transform) e "Desfazer transformação"
- **Dano de fim de turno**: no painel de cada Pokémon o Mestre tem botões já calculados
  (`residualRowHtml`): clima (Areia/Granizo 1/16, com imunidade por tipo — Tera incluso — e por
  ability), Queimadura 1/16, Veneno 1/8, Tóxico n/16 (contador `battle.toxN`, zera ao trocar/mudar de
  status), Campo de Grama +1/16 (só "no chão": sem Voador/Levitate) e frações genéricas. A base é o HP
  máximo sem o Dynamax, arredondando pra baixo, mínimo 1 (`residualOf`). O motivo vai junto
  (`reason` no `PATCH /api/pokemon/:id/battle`, lista `RESIDUAL_REASONS`) e aparece no log
- **Fim de batalha**: o Mestre escolhe o vencedor (`winner`: `a`, `b` ou `draw`). A arte de resumo
  (`drawBattleArt`, no frontend) é desenhada em 640×360 e ampliada 2× sem suavização; os
  Pokémon aparecem na ordem de `revealed` (ordem de entrada em campo), preenchendo o arco de
  pokébolas a partir da ponta de cima (perto do VS): anti-horário na esquerda, horário na direita
  (`ART_SLOTS`). Cada Pokémon aparece como terminou — ou como foi **nocauteado**: nocauteado fica cinza e
  translúcido (`fadeFainted`), e na forma em que estava: cristal de Tera, Dynamax com aura vermelha
  (`addArtAura`), Gigantamax com o sprite G-Max + aura, Mega/Battle Bound, transformado.
  Em volta de cada pokébola usada vai o **HP com que ele terminou** (`gauge`): um anel que começa no topo
  e anda no sentido horário, encolhendo conforme a vida cai, verde → amarelo → vermelho como a barra
  (nocauteado = anel vazio); e quem estava **em campo no fim** ganha uma **borda dourada** por fora
  (`active` no `pick` e no `seen` público). Como o Dynamax e a
  transformação acabam quando ele sai de campo, o servidor guarda a forma no nocaute em `battle.faintForm`
  (esquecida se ele for revivido); vai pro jogador em `mine.faintForm` e já resolvida no `seen` público
  (`tera`, `dmax`, `transformSprite`). Na ficha, os Status ficam em duas colunas: HP | SPE, ATK | SPA, DEF | SPD

## Armadilha conhecida

`cleanMonData()` em `server.js` tem uma **lista branca de campos**. Qualquer campo novo
adicionado à ficha precisa ser incluído nessa lista, senão o servidor descarta
silenciosamente na hora de salvar e o dado some.

## Dados embutidos

Dentro de `public/index.html`:

- `POKEDEX` — 1025 espécies + 141 formas alternativas (regionais de Alola/Galar/Hisui/Paldea,
  Rotom, Deoxys, Therian, formas de gênero, Lycanroc, Basculin/Basculegion etc.), com Status base,
  tipos, estágio evolutivo e flags de lendário.
  Formas têm `id` do PokeAPI (10xxx, serve pro sprite), `species` (nº da Pokédex) e
  `battleOnly` quando só existem em batalha. **Mega, Primitivo e Gigantamax ficam de fora de
  propósito** (têm outras regras no sistema); formas só cosméticas (Totem, bonés do Pikachu, cores
  do Minior, montarias do Koraidon/Miraidon) também. `base100` é sempre o Status da forma inicial da
  linha evolutiva *daquela forma* (Arcanine de Hisui → Growlithe de Hisui). Nomes são os oficiais
  em inglês; `aka` guarda o nome antigo pra fichas salvas antes continuarem resolvendo
- `MOVES` — 937 golpes com tipo, categoria, poder, dado convertido, accuracy, prioridade
  e descrição (em inglês; não existe fonte oficial em português)
- Abilities: cada entrada da `POKEDEX` tem `abilities` (normais) e `hidden` (a secreta, quando
  existe), por espécie **e por forma** (Vulpix de Alola ≠ Vulpix). `ABILITIES` mapeia nome →
  descrição (texto dos jogos, em inglês). A ficha guarda só o nome em `ability`; se o nome
  não estiver em `ABILITIES`, é uma ability personalizada e é preservada ao trocar a espécie

Sprites vêm do repositório público do PokeAPI por URL, não ficam no projeto.

## Convenções

- Interface toda em português; identificadores no código em inglês
- Estética pixel art estilo GBA/PokéRogue: fontes "Press Start 2P" e "Silkscreen",
  molduras com `clip-path` de cantos em degrau e borda em gradiente por camadas
  (`box-shadow` com `inset`), variáveis `--fill` e `--edge` por componente
- A ficha tem proporção 16:9 para encaixar em slides. No canto de baixo à direita fica o quadro
  de fraquezas e resistências (`matchupHtml`, tabela `TYPE_CHART` da 6ª geração em diante; não
  considera abilities como Levitate). O campo `notes` continua salvo na ficha, mas não aparece
- Texto em canvas pixel art (arte de fim de batalha): usar o `text()` de `drawBattleArt`, que tira
  a suavização — `fillText` direto sai borrado quando a imagem é ampliada
- O frontend faz polling do servidor (`schedulePoll` → `pollOnce` → `refreshState`): a cada **1s** com
  uma batalha aberta, 5s fora dela ou com a aba em segundo plano. Um pedido por vez (o próximo só sai
  quando o anterior responde); resposta igual à última não redesenha; resposta que cruzou uma gravação
  (`API.pendingWrites`/`API.writeSeq`) é descartada, pra não desfazer a atualização otimista do Mestre

## Como rodar local

```bash
npm install
npm start          # http://localhost:3000 — sem banco, roda em memória
```

Com banco:

```bash
DATABASE_URL=postgres://... npm start
```

## Ideias ainda não implementadas

- Status Conditions (Burn, Paralysis, Sleep, Poison, Freeze, Confusion...)
- Controle de turno e iniciativa por SPE
- Rolagem de dados integrada (acerto, dano, crítico, esquiva, bloqueio, colisão)
- Tradução das descrições dos golpes
