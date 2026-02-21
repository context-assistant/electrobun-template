" --- General ---
set nocompatible          " Use Vim defaults, not Vi
syntax on                 " Enable syntax highlighting
filetype plugin indent on " Enable filetype detection
set encoding=utf-8
set t_Co=256              " Force 256 colors
set autoread              " Update files when they are modified externally
set splitright            " By default split vertical split to the right side
set shell=/bin/bash
set nowrap                " nowrap by default

" --- UI ---
set number                " Show line numbers
set cursorline            " Highlight current line
set showmatch             " Show matching brackets
set noswapfile            " Disable swap files (optional)

" --- Indentation ---
set tabstop=4             " 4 spaces per tab
set shiftwidth=4          " 4 spaces for autoindent
set expandtab             " Use spaces instead of tabs
set smarttab
set autoindent

" --- Search ---
set hlsearch              " Highlight searches
set incsearch             " Search as you type
set ignorecase            " Ignore case in search
set smartcase             " Overrides ignorecase if capital exists

" --- Color Scheme ---
set background=dark         " Or light
colorscheme habamax       " custom built-in theme
" colorscheme catppuccin    " custom built-in theme
" colorscheme quiet         " custom built-in theme
" colorscheme default       " Default built-in theme  