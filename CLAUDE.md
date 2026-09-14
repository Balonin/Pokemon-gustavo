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
- **Teto**: nenhum Status passa de **90**
- **HP em batalha** = Status de HP × 2
- **Margem de crítico** = 10% do Status (mesmo arredondamento)
- **Estágios de Status**: cada estágio vale 10% do Status original, limite de ±6.
  HP não recebe estágio.
- **Dado de dano de um golpe** = poder do jogo ÷ 2, arredondado para baixo
  (ex: Tackle 40 → 1d20)
- **Accuracy**: acerta tirando ≤ (Status × accuracy do golpe) num d100

Funções relevantes em `public/index.html`: `roundStatus`, `evoStepsFor`,
`computeFixedAndPoints`, `finalStatsFor`, `critMarginFor`, `effectiveStat`.

## Papéis e permissões

- Quem cria a sala é **Mestre**; quem entra pelo código/link é **Jogador**
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
  O Jogador escolhe ao entrar na sala e troca depois pelo ícone no topo
- Só o Mestre recebe `members` e `npcs` em `/api/state`
- **HP e estágios de batalha** (`battle` da ficha) só o Mestre altera. Jogador pode reordenar
  as próprias fichas (`order`), e salvar uma ficha preserva `battle` e `order`
- **Batalhas** (tabela `battles`): o Mestre cria (`POST /api/battles`) com dois lados — jogador,
  NPC ou ele mesmo — e o time de cada um (até 6), troca o Pokémon em campo e encerra/exclui.
  `revealed` guarda todo Pokémon que já esteve em campo
- **Visibilidade na batalha, como nos jogos**: o jogador recebe em `/api/state` só as batalhas
  em que luta, já filtradas por `playerBattleView` — o próprio time completo e, do adversário,
  apenas o Pokémon em campo (espécie, nível, tipos, HP em %, estágios), o tamanho do time e
  os já utilizados. Golpes, Status, ability, notas, ids e HP exato do outro lado nunca saem do
  servidor. O cliente do Mestre grava `maxHp` junto do `hp` pra essa porcentagem
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
  `DEFAULT_BATTLE_THEME` (no `index.html`; hoje `null` — o tema padrão ainda vai ser enviado)
- **Fim de batalha**: o Mestre escolhe o vencedor (`winner`: `a`, `b` ou `draw`). A arte de resumo
  (`drawBattleArt`, no frontend) é desenhada em 640×360 e ampliada 2× sem suavização; os
  Pokémon aparecem na ordem de `revealed` (ordem de entrada em campo)

## Armadilha conhecida

`cleanMonData()` em `server.js` tem uma **lista branca de campos**. Qualquer campo novo
adicionado à ficha precisa ser incluído nessa lista, senão o servidor descarta
silenciosamente na hora de salvar e o dado some.

## Dados embutidos

Dentro de `public/index.html`:

- `POKEDEX` — 1025 espécies + 116 formas alternativas (regionais de Alola/Galar/Hisui/Paldea,
  Rotom, Deoxys, Therian etc.), com Status base, tipos, estágio evolutivo e flags de lendário.
  Formas têm `id` do PokeAPI (10xxx, serve pro sprite), `species` (nº da Pokédex) e
  `battleOnly` quando só existem em batalha. **Mega, Primitivo e Gigantamax ficam de fora de
  propósito** (têm outras regras no sistema). `base100` é sempre o Status da forma inicial da
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
- A ficha tem proporção 16:9 para encaixar em slides
- O frontend faz polling do servidor a cada 5s (`refreshState`)

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
- Clima (Weather) e Terreno (Terrain) ativos na batalha
