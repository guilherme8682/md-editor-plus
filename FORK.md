# Propósito deste fork

Este repositório é o fork pessoal de Guilherme Rocha do MD Editor Plus, criado em 21/10/2026 para receber customizações do editor Markdown no VS Code.

A experiência de edição por blocos, com texto formatado durante a escrita e menu `/`, foi aprovada no uso. O fork permite evoluir essa experiência para o ambiente pessoal sem depender exclusivamente das opções oferecidas pelo projeto original.

## Origem e localização

| Referência | Valor |
| --- | --- |
| Fork | https://github.com/guilherme8682/md-editor-plus |
| Projeto original | https://github.com/aviranrevach/md-editor-plus |
| Checkout local | `/Users/gui/Documents/Pessoal/repos/md-editor-plus` |
| Branch principal | `main` |
| Remote `origin` | Fork de Guilherme Rocha |
| Remote `upstream` | Projeto original de Aviran Revach |
| Versão de origem neste início | `0.9.2` |
| Commit de origem | `ef9f1987f17c088362d317d478ba9cc58b114a47` |

O código fica fora do vault do Life OS. O histórico e as alterações do plugin pertencem a este repositório.

## Contexto e escopo

A necessidade que motivou a avaliação do fork foi a integração visual com o tema personalizado do VS Code. A sincronização de tema da extensão original acompanha o modo claro/escuro; ela não herda toda a paleta personalizada do editor.

Neste início foram preparados o fork, os remotes e a documentação. As customizações funcionais e visuais serão definidas nos próximos pedidos. Ainda não foi gerada nem instalada uma versão personalizada.

## Desenvolvimento

O projeto usa TypeScript, TipTap e esbuild. Os comandos abaixo são os scripts existentes no `package.json`:

```sh
npm ci
npm run compile
npm test -- --runInBand
npm run package
```

`npm run package` gera o pacote `.vsix` para instalação local no VS Code. A preparação inicial do fork não executou instalação de dependências, build nem testes do código.

Antes de distribuir ou instalar a primeira versão personalizada, defina identidade própria para a extensão, seus comandos e configurações, evitando colisões com a versão original.

## Manutenção

- Mantenha as alterações próprias em commits separados, preferencialmente em branches `codex/<descricao>` durante o desenvolvimento.
- Use `origin` para publicar neste fork e `upstream` para consultar e incorporar melhorias do original.
- Revise as mudanças do original antes de integrá-las e valide o comportamento afetado pelas customizações.
- Preserve a licença MIT e os créditos de Aviran Revach em [LICENSE](LICENSE).

A documentação original de funcionalidades e uso permanece em [README.md](README.md).
