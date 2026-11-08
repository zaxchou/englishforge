'use strict';
// Bound excerpts to an exact level-2 language section, including on multilingual pages.
function languageSection(text, language, title='') {
 if(!/^[A-Za-z ]+$/.test(language))throw Error('INVALID_SOURCE_LANGUAGE');
 const match=new RegExp('^=='+language+'==[ \\t]*\\r?$','m').exec(text);
 if(!match)throw Error('NO_'+language.toUpperCase().replaceAll(' ','_')+' '+title);
 const rest=text.slice(match.index+match[0].length);
 const next=/^==[^=\r\n][^\r\n]*==[ \t]*\r?$/m.exec(rest);
 return rest.slice(0,next?next.index:rest.length);
}
function englishEtymology(text, title='') {
 const english=languageSection(text,'English',title);
 const ety=/^===Etymology[^\r\n]*===[ \t]*\r?\n/m.exec(english);
 if(!ety)throw Error('NO_ENGLISH_ETYMOLOGY '+title);
 const body=english.slice(ety.index+ety[0].length).split(/^===/m)[0].trim();
 if(!body)throw Error('EMPTY_ENGLISH_ETYMOLOGY '+title);
 return body;
}
module.exports={englishEtymology,languageSection};
