      /* X-Ray's Lua dialect accepts C-style comments (also in its LuaJIT
         lexer). Keep this in the lexer so strings and division are untouched. */
      case '/': {
        next(ls);
        if (ls->current == '/') {
          while (!currIsNewline(ls) && ls->current != EOZ)
            next(ls);
          continue;
        }
        if (ls->current == '*') {
          next(ls);
          for (;;) {
            if (ls->current == EOZ)
              luaX_lexerror(ls, "unfinished C-style comment", TK_EOS);
            if (currIsNewline(ls)) {
              inclinenumber(ls);
            } else if (ls->current == '*') {
              next(ls);
              if (ls->current == '/') {
                next(ls);
                break;
              }
            } else {
              next(ls);
            }
          }
          continue;
        }
        return '/';
      }
