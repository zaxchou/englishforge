'use strict';
function englishEtymology(text, title='') {
 const match=/^==English==[ \t]*\r?$/m.exec(text);
 if(!match)throw Error('NO_ENGLISH '+title);
 const rest=text.slice(match.index+match[0].length);
 const next=/^==[^=\r\n][^\r\n]*==[ \t]*\r?$/m.exec(rest);
 const english=rest.slice(0,next?next.index:rest.length);
 const ety=/^===Etymology[^\r\n]*===[ \t]*\r?\n/m.exec(english);
 if(!ety)throw Error('NO_ENGLISH_ETYMOLOGY '+title);
 const body=english.slice(ety.index+ety[0].length).split(/^===/m)[0].trim();
 if(!body)throw Error('EMPTY_ENGLISH_ETYMOLOGY '+title);
 return body;
}
module.exports={englishEtymology};
