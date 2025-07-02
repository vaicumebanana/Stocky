// Inicializa o jogo de xadrez e o tabuleiro
var game = new Chess();
var board = null;
var stockfish = null; // A instância do Stockfish.js
var currentDepth = 10;
var currentSkillLevel = 10; // Corresponde ao "Skill Level" do Stockfish, não um rating ELO

var $status = $('#game-status');
var $analysisOutput = $('#analysis-output');
var $depthSlider = $('#depth-slider');
var $currentDepthSpan = $('#current-depth');
var $skillLevelSlider = $('#skill-level-slider');
var $currentSkillLevelSpan = $('#current-skill-level');

// --- Funções de Ajuda e Integração com Stockfish ---

/**
 * Envia um comando para o Stockfish e lida com a resposta.
 * @param {string} command - O comando UCI a ser enviado (ex: "go depth 10", "position startpos moves e2e4").
 * @returns {Promise<string>} Uma promessa que resolve com a resposta do Stockfish.
 */
function sendStockfishCommand(command) {
    return new Promise((resolve) => {
        stockfish.onmessage = function (event) {
            var message = event.data || event;
            // Filtra mensagens irrelevantes para manter a saída limpa,
            // e captura as linhas que queremos.
            if (message.startsWith('bestmove') || message.startsWith('info depth')) {
                resolve(message);
                stockfish.onmessage = null; // Limpa o handler para a próxima requisição
            } else if (message.includes('No bestmove found')) {
                resolve('No bestmove found'); // Em caso de erro ou fim de jogo
                stockfish.onmessage = null;
            }
        };
        stockfish.postMessage(command);
    });
}

/**
 * Obtém o melhor movimento do Stockfish para a posição atual.
 * @param {number} depth - Profundidade de busca.
 * @returns {Promise<string>} A promessa que resolve com o comando 'bestmove' do Stockfish.
 */
async function getStockfishMove(depth) {
    await sendStockfishCommand('ucinewgame'); // Garante que o Stockfish está em um estado limpo
    await sendStockfishCommand('isready');
    await sendStockfishCommand('setoption name Skill Level value ' + currentSkillLevel);
    await sendStockfishCommand('position fen ' + game.fen());
    const response = await sendStockfishCommand('go depth ' + depth);
    console.log("Stockfish Best Move Response:", response);
    return response;
}

/**
 * Obtém uma análise da posição atual do Stockfish.
 * @param {number} depth - Profundidade de busca para análise.
 * @returns {Promise<string>} Uma promessa que resolve com a saída de análise do Stockfish.
 */
async function getStockfishAnalysis(depth) {
    await sendStockfishCommand('ucinewgame');
    await sendStockfishCommand('isready');
    await sendStockfishCommand('position fen ' + game.fen());
    const response = await sendStockfishCommand('go depth ' + depth + ' ponder'); // 'ponder' para análise contínua
    return response;
}

// --- Funções de Tabuleiro e Lógica do Jogo ---

// Função chamada quando uma peça começa a ser arrastada
function onDragStart(source, piece, position, orientation) {
    // Não permite arrastar se o jogo terminou ou se não for o turno do jogador
    if (game.game_over() === true ||
        (game.turn() === 'w' && piece.search(/^b/) !== -1) ||
        (game.turn() === 'b' && piece.search(/^w/) !== -1)) {
        return false;
    }
}

// Função chamada quando uma peça é solta
function onDrop(source, target) {
    // Tenta fazer o movimento
    var move = game.move({
        from: source,
        to: target,
        promotion: 'q' // Sempre promove para rainha por simplicidade
    });

    // Se o movimento for ilegal, retorna
    if (move === null) return 'snapback';

    updateStatus();
    makeStockfishMove(); // Faz o Stockfish responder após o movimento do jogador
}

// Atualiza a posição do tabuleiro após um 'snapback' (movimento ilegal)
function onSnapEnd() {
    board.position(game.fen());
}

// Atualiza o status do jogo (xeque, mate, turno, etc.)
function updateStatus() {
    var status = '';
    var moveColor = 'Brancas';
    if (game.turn() === 'b') {
        moveColor = 'Pretas';
    }

    if (game.in_checkmate() === true) {
        status = 'Jogo Encerrado, ' + moveColor + ' está em xeque-mate.';
        $analysisOutput.text('');
    } else if (game.in_draw() === true) {
        status = 'Jogo Encerrado, Empate.';
        $analysisOutput.text('');
    } else {
        status = 'Turno das ' + moveColor;
        if (game.in_check() === true) {
            status += ', ' + moveColor + ' está em xeque.';
        }
        // Solicita análise do Stockfish após cada movimento
        getStockfishAnalysis(currentDepth).then(analysis => {
             // Limita a saída para as últimas 5 linhas de 'info depth'
            const lines = analysis.split('\n');
            const relevantLines = lines.filter(line => line.startsWith('info depth')).slice(-5);
            $analysisOutput.text(relevantLines.join('\n'));
        });
    }
    $status.html(status);
}

// Função para o Stockfish fazer um movimento
async function makeStockfishMove() {
    if (game.game_over() === true) return;

    $status.text('Stockfish pensando...');
    const stockfishResponse = await getStockfishMove(currentDepth);
    const bestMoveMatch = stockfishResponse.match(/bestmove\s(\S+)/);

    if (bestMoveMatch && bestMoveMatch[1]) {
        const bestMove = bestMoveMatch[1];
        console.log("Stockfish Best Move:", bestMove);
        game.move(bestMove, { sloppy: true }); // 'sloppy' para aceitar formato uci
        board.position(game.fen());
        updateStatus();
    } else {
        $status.text('Stockfish não encontrou um movimento ou o jogo terminou.');
        console.error("Erro ao obter o melhor movimento do Stockfish:", stockfishResponse);
    }
}

// --- Event Listeners e Inicialização ---

$(document).ready(function() {
    // Inicializa o tabuleiro
    board = Chessboard('board', {
        draggable: true,
        position: 'start',
        onDragStart: onDragStart,
        onDrop: onDrop,
        onSnapEnd: onSnapEnd
    });

    // Inicializa o Stockfish.js
    stockfish = new Worker('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');
    stockfish.postMessage('uci'); // Envia o comando UCI para iniciar o Stockfish
    stockfish.postMessage('isready');
    stockfish.postMessage('ucinewgame'); // Inicia um novo jogo no Stockfish

    // Atualiza os valores dos sliders na interface
    $depthSlider.on('input', function() {
        currentDepth = $(this).val();
        $currentDepthSpan.text(currentDepth);
    });

    $skillLevelSlider.on('input', function() {
        currentSkillLevel = $(this).val();
        $currentSkillLevelSpan.text(currentSkillLevel);
        // O Stockfish aplica o skill level automaticamente nas próximas chamadas 'go'
    });

    // Botão Novo Jogo
    $('#new-game-btn').on('click', function() {
        game.reset();
        board.position('start');
        stockfish.postMessage('ucinewgame');
        stockfish.postMessage('isready');
        $analysisOutput.text('');
        updateStatus();
    });

    // Botão Pedir Dica
    $('#hint-btn').on('click', async function() {
        if (game.game_over() === true) {
            $analysisOutput.text('O jogo já terminou, não há dicas.');
            return;
        }
        $analysisOutput.text('Pensando em uma dica...');
        const hintResponse = await getStockfishMove(currentDepth); // Usa a mesma função, mas apenas mostra o bestmove
        const bestMoveMatch = hintResponse.match(/bestmove\s(\S+)/);
        if (bestMoveMatch && bestMoveMatch[1]) {
            $analysisOutput.text('Dica: Melhor movimento é ' + bestMoveMatch[1]);
        } else {
            $analysisOutput.text('Não foi possível obter uma dica.');
        }
    });

    // Botão Mover Stockfish (útil para testar ou jogar contra o Stockfish)
    $('#stockfish-move-btn').on('click', function() {
        makeStockfishMove();
    });

    // Estado inicial
    updateStatus();
});

// --- As 10 Funções de Xadrez (Exemplos e Notas) ---
// Algumas dessas funções são fornecidas nativamente pela biblioteca chess.js ou Stockfish.js

// 1. Mover Peça: Implementado via game.move() e onDrop.
// 2. Verificar Xeque: Implementado via game.in_check() em updateStatus.
// 3. Verificar Xeque-Mate: Implementado via game.in_checkmate() em updateStatus.
// 4. Verificar Afogamento (Stalemate): Implementado via game.in_draw() (chess.js lida com stalemate, threefold, 50-move rule).
// 5. Gerar Movimentos Legais: Implementado via game.moves() (para human, mas Stockfish internamente faz isso).
// 6. Reiniciar Jogo: Implementado no botão 'Novo Jogo' via game.reset().
// 7. Desfazer Movimento: Pode ser implementado com game.undo() (requer um botão/lógica adicional).
// 8. Obter Dica (Stockfish): Implementado no botão 'Pedir Dica' usando getStockfishMove.
// 9. Obter Melhor Movimento (Stockfish): Implementado em makeStockfishMove usando getStockfishMove.
// 10. Analisar Posição (Stockfish): Implementado em updateStatus usando getStockfishAnalysis para mostrar 'info depth'.

/* Exemplo de como seria a função de desfazer:
function undoLastMove() {
    game.undo();
    board.position(game.fen());
    updateStatus();
}
// Você adicionaria um botão no HTML para chamar essa função.
*/
