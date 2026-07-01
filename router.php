<?php
/**
 * Router for PHP built-in server — enables local preview of affiliate landings
 * that require $rawClick / $click tracker variables.
 */
$rawClick = true;
$click = true;

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$docRoot = $_SERVER['DOCUMENT_ROOT'];
$fullPath = $docRoot . rawurldecode($path);

if ($path !== '/' && file_exists($fullPath) && is_file($fullPath)) {
    $ext = strtolower(pathinfo($fullPath, PATHINFO_EXTENSION));
    if ($ext !== 'php') {
        return false;
    }
    chdir(dirname($fullPath));
    require $fullPath;
    return true;
}

if (is_dir($fullPath) && file_exists(rtrim($fullPath, '/') . '/index.php')) {
    $indexPath = rtrim($fullPath, '/') . '/index.php';
    chdir(dirname($indexPath));
    require $indexPath;
    return true;
}

if ($path === '/' && file_exists($docRoot . '/index.php')) {
    chdir($docRoot);
    require $docRoot . '/index.php';
    return true;
}

return false;
